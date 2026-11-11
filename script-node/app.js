require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const xml2js = require('xml2js');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeLib = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Papa = require('papaparse');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload());

// Configurações de Delays e Portas
const PORT = process.env.PORT || 5000;
const DELAY_MIN_MS = process.env.DELAY_MIN_MS || 60000;
const DELAY_MAX_MS = process.env.DELAY_MAX_MS || 120000;

// Proteção global contra crashes por rejeições não tratadas do WhatsApp/Puppeteer
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

// ==========================================
// PARSER DE SPINTAX INTELIGENTE (ANTI-BAN)
// ==========================================
function parseSpintax(text) {
    if (!text || typeof text !== 'string') return text;
    const regex = /\{([^{}]+)\}/g;
    let iterations = 0;
    while (regex.test(text) && iterations < 10) {
        text = text.replace(regex, (match, choices) => {
            const lower = choices.trim().toLowerCase();
            // Preserva tags dinâmicas do sistema
            if (['nome', 'endereco', 'nota', 'id', 'categoria', 'bairro', 'cidade', 'searchid'].includes(lower)) {
                return match;
            }
            if (!choices.includes('|')) {
                return match;
            }
            const parts = choices.split('|');
            return parts[Math.floor(Math.random() * parts.length)];
        });
        iterations++;
    }
    return text;
}

// ==========================================
// SESSÃO DO CRM (SUPABASE)
// ==========================================
function getCrmSessionClient() {
    try {
        const sessionPath = path.join(os.homedir(), '.crm-session.json');
        let sessionData = {};
        if (fs.existsSync(sessionPath)) {
            try {
                sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
            } catch (parseErr) {
                console.error("Erro ao ler .crm-session.json:", parseErr);
            }
        }

        const supabaseUrl = process.env.SUPABASE_URL || sessionData.supabaseUrl || 'https://rjrfltyygudfzbbyhlgb.supabase.co';
        const serviceKey = process.env.SUPABASE_KEY;

        if (serviceKey) {
            const client = createClient(supabaseUrl, serviceKey, {
                auth: { persistSession: false }
            });
            return { 
                client, 
                vendorId: sessionData.user_id || 'ccdd5f35-ff21-41d2-9c32-158920002c2b', 
                email: sessionData.email || 'joao@vendas.com',
                error: null
            };
        }

        if (sessionData.supabaseUrl && sessionData.supabaseKey && sessionData.user_id) {
            const client = createClient(sessionData.supabaseUrl, sessionData.supabaseKey);
            return { 
                client, 
                vendorId: sessionData.user_id, 
                email: sessionData.email,
                error: null
            };
        }
        return { client: null, vendorId: null, email: null, error: 'Arquivo .crm-session.json não encontrado. Faça o login no Lead Hunter primeiro.' };
    } catch (e) {
        return { client: null, vendorId: null, email: null, error: e.message };
    }
}

// ==========================================
// SISTEMA DE LOGS EM TEMPO REAL (SSE)
// ==========================================
let clients = [];

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.push(res);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

const sendLog = (msg, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    clients.forEach(client => {
        try {
            client.write(`data: ${JSON.stringify({ msg, type })}\n\n`);
        } catch (e) {}
    });
};

// ==========================================
// GESTÃO DE ESTADO (LEADS E CAMPANHAS)
// ==========================================
const leadsStateFile = './leads_state.json';
const campaignsFile = './campaigns.json';
const chipsConfigFile = './chips_config.json';

const carregarLeads = () => {
    if (fs.existsSync(leadsStateFile)) {
        try { return JSON.parse(fs.readFileSync(leadsStateFile, 'utf-8')); } catch (e) { return []; }
    }
    return [];
};
const salvarLeads = (data) => fs.writeFileSync(leadsStateFile, JSON.stringify(data, null, 2), 'utf-8');

const carregarCampaigns = () => {
    if (fs.existsSync(campaignsFile)) {
        try { return JSON.parse(fs.readFileSync(campaignsFile, 'utf-8')); } catch (e) { return {}; }
    }
    return {};
};
const salvarCampaigns = (data) => fs.writeFileSync(campaignsFile, JSON.stringify(data, null, 2), 'utf-8');

const carregarChipsConfig = () => {
    if (fs.existsSync(chipsConfigFile)) {
        try { return JSON.parse(fs.readFileSync(chipsConfigFile, 'utf-8')); } catch (e) { return {}; }
    }
    return {};
};
const salvarChipsConfig = (data) => fs.writeFileSync(chipsConfigFile, JSON.stringify(data, null, 2), 'utf-8');

// Reset Diário de Cotas de Disparos
function verificarResetDiarioChips() {
    const hoje = new Date().toISOString().slice(0, 10);
    const configs = carregarChipsConfig();
    let modificado = false;
    for (const id in configs) {
        if (configs[id].lastResetDate !== hoje) {
            configs[id].dailySent = 0;
            configs[id].lastResetDate = hoje;
            configs[id].sentSinceLastBreak = 0;
            configs[id].inCoffeeBreakUntil = null;
            modificado = true;
        }
    }
    if (modificado) {
        salvarChipsConfig(configs);
        sendLog('🔄 [Anti-Ban] Cotas diárias dos chips reiniciadas para o novo dia.', 'system');
    }
}
setInterval(verificarResetDiarioChips, 60000);

// ==========================================
// CLUSTER MULTI-CHIP (WHATSAPP-WEB.JS)
// ==========================================
const chipInstances = {
    chip_1: { client: null, status: 'disconnected', qrCode: null, phone: null, isReady: false },
    chip_2: { client: null, status: 'disconnected', qrCode: null, phone: null, isReady: false },
    chip_3: { client: null, status: 'disconnected', qrCode: null, phone: null, isReady: false },
    chip_4: { client: null, status: 'disconnected', qrCode: null, phone: null, isReady: false },
    chip_5: { client: null, status: 'disconnected', qrCode: null, phone: null, isReady: false },
};

const botIsSendingTo = new Set();
const activeProcessingLeads = new Set();

function createWppClient(clientId) {
    return new Client({
        authStrategy: new LocalAuth({ clientId: clientId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        }
    });
}

function registerChipEvents(chipId, client) {
    const configs = carregarChipsConfig();
    const chipName = (configs[chipId] && configs[chipId].name) || chipId;

    client.on('qr', async (qr) => {
        try {
            const qrBase64 = await qrcodeLib.toDataURL(qr);
            chipInstances[chipId].qrCode = qrBase64;
            chipInstances[chipId].status = 'qrcode';
            sendLog(`[${chipName}] QR Code gerado! Escaneie na tela.`, 'system');
            clients.forEach(c => {
                try {
                    c.write(`data: ${JSON.stringify({ type: 'chip_qrcode_event', chipId, qrcode: qrBase64 })}\n\n`);
                } catch(e){}
            });
        } catch (err) {
            console.error(`Erro ao gerar QR Base64 para ${chipId}:`, err);
        }
    });

    client.on('ready', () => {
        chipInstances[chipId].isReady = true;
        chipInstances[chipId].status = 'connected';
        chipInstances[chipId].qrCode = null;
        const wid = client.info && client.info.wid ? client.info.wid.user : null;
        chipInstances[chipId].phone = wid;

        const curConfigs = carregarChipsConfig();
        if (curConfigs[chipId]) {
            curConfigs[chipId].status = 'connected';
            curConfigs[chipId].phone = wid;
            salvarChipsConfig(curConfigs);
        }

        sendLog(`[${chipName}] WhatsApp conectado com sucesso! (${wid || 'Conectado'})`, 'success');
        clients.forEach(c => {
            try {
                c.write(`data: ${JSON.stringify({ type: 'chip_connected_event', chipId, phone: wid })}\n\n`);
            } catch(e){}
        });
    });

    client.on('disconnected', (reason) => {
        chipInstances[chipId].isReady = false;
        chipInstances[chipId].status = 'disconnected';
        chipInstances[chipId].qrCode = null;
        chipInstances[chipId].phone = null;

        const curConfigs = carregarChipsConfig();
        if (curConfigs[chipId]) {
            curConfigs[chipId].status = 'disconnected';
            salvarChipsConfig(curConfigs);
        }

        sendLog(`[${chipName}] WhatsApp desconectado: ${reason}`, 'error');
        clients.forEach(c => {
            try {
                c.write(`data: ${JSON.stringify({ type: 'chip_disconnected_event', chipId })}\n\n`);
            } catch(e){}
        });

        // Reconexão suave se o chip ainda estiver habilitado
        setTimeout(() => {
            const cCfg = carregarChipsConfig();
            if (cCfg[chipId] && cCfg[chipId].enabled) {
                initChipInstance(chipId);
            }
        }, 8000);
    });
}

function registerChipMessageHandlers(chipId, client) {
    client.on('message', async msg => {
        if (msg.fromMe) return;
        if (msg.isGroupMsg) return;

        let contact = null;
        try { contact = await msg.getContact(); } catch (e) {}
        const pushName = (contact && (contact.pushname || contact.name || contact.number)) || 'Desconhecido';
        const numLimpoMsg = msg.from.replace('@c.us', '');

        // Trava anti-concorrência
        if (activeProcessingLeads.has(numLimpoMsg)) return;
        activeProcessingLeads.add(numLimpoMsg);

        try {
            const leads = carregarLeads();
            const fIdx = leads.findIndex(f => {
                if (!f.telefone) return false;
                const fTel = String(f.telefone).replace('@c.us', '');
                return fTel === numLimpoMsg || f.telefone === msg.from || (contact && contact.number && fTel.includes(contact.number));
            });

            let campanhaId = null;
            if (fIdx >= 0) {
                if (leads[fIdx].status === 'atendimento_humano') return;
                campanhaId = leads[fIdx].campanhaId;
            }

            // DETECTOR INTELIGENTE DE RESPOSTAS AUTOMÁTICAS E ROBÔS
            const leadRecord = fIdx >= 0 ? leads[fIdx] : null;
            const botCheck = detectAutomatedReply(msg.body, leadRecord);

            if (botCheck.isBot) {
                sendLog(`[🤖 Auto-Resposta no ${chipId}] Lead "${pushName}" enviou mensagem automática (${botCheck.razao}). Robô ignorará.`, 'warning');
                if (fIdx >= 0) {
                    leads[fIdx].status = 'resposta_automatica';
                    leads[fIdx].motivoBot = botCheck.razao;
                    leads[fIdx].ultimaMsgBot = new Date().toISOString();
                    salvarLeads(leads);
                }
                return;
            }

            // Se for resposta humana legítima:
            if (fIdx >= 0) {
                if (leads[fIdx].status === 'aguardando_resposta' || leads[fIdx].status === 'resposta_automatica') {
                    leads[fIdx].status = 'respondido';
                    salvarLeads(leads);
                    sendLog(`[Interação Humana no ${chipId}] Lead "${pushName}" respondeu e saiu da fila de anti-vácuo.`, 'system');
                }
            }

            if (!campanhaId) return;

            if (fIdx >= 0 && leads[fIdx].botRespondeu) {
                sendLog(`[Bot] Lead "${pushName}" já recebeu a resposta automática desta etapa. Aguardando vendedor humano.`, 'info');
                return;
            }

            const campaigns = carregarCampaigns();
            const camp = campaigns[campanhaId];

            if (camp && camp.rules && camp.rules.length > 0) {
                const rules = camp.rules;
                const textoLimpo = msg.body.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

                for (const rule of rules) {
                    const keywords = rule.keywords.split(',').map(k => k.trim());
                    const match = keywords.some(k => keywordMatch(textoLimpo, k));

                    if (match) {
                        sendLog(`Regra da campanha [${camp.name}] acionada para "${pushName}". Respondendo via ${chipId}...`, 'system');
                        const primeiroNome = pushName ? pushName.split(' ')[0] : 'lá';
                        let respostaFinal = parseSpintax(rule.response);
                        respostaFinal = respostaFinal.replace(/{nome}/g, primeiroNome);

                        try {
                            try {
                                const chat = await msg.getChat();
                                await chat.sendStateTyping();
                                await sleep(2500);
                                await chat.clearState();
                            } catch (typingErr) {}

                            const numDest = msg.from.replace('@c.us', '');
                            botIsSendingTo.add(numDest);
                            await client.sendMessage(msg.from, respostaFinal);
                            setTimeout(() => botIsSendingTo.delete(numDest), 5000);

                            sendLog(`Bot respondeu com sucesso para ${pushName}!`, 'success');

                            if (fIdx >= 0) {
                                const currentLeads = carregarLeads();
                                if (currentLeads[fIdx]) {
                                    currentLeads[fIdx].botRespondeu = true;
                                    currentLeads[fIdx].botRespondidoEm = new Date().toISOString();
                                    salvarLeads(currentLeads);
                                }
                            }

                            if (rule.isHotLead) {
                                const { client: crmClient, vendorId } = getCrmSessionClient();
                                if (crmClient) {
                                    const { error } = await crmClient
                                        .from('leads')
                                        .insert([{
                                            name: pushName,
                                            contact: numLimpoMsg,
                                            status: 'novo',
                                            utm_source: `WhatsApp Outbound - ${camp.name}`,
                                            assigned_to: vendorId || null
                                        }]);
                                    if (error) {
                                        sendLog(`[CRM ERROR] Falha ao gravar Lead: ${error.message}`, 'error');
                                    } else {
                                        sendLog(`[CRM] 🔥 Lead [${pushName}] cadastrado no Kanban!`, 'success');
                                    }
                                }
                            }
                        } catch (e) {
                            console.error("DEBUG ERRO BOT:", e);
                            sendLog(`Erro no bot: ${e.message || JSON.stringify(e)}`, 'error');
                        }
                        return;
                    }
                }
            }
        } finally {
            setTimeout(() => activeProcessingLeads.delete(numLimpoMsg), 8000);
        }
    });

    client.on('message_create', async msg => {
        if (!msg.fromMe) return;
        if (msg.isGroupMsg) return;

        const numLimpoMsg = msg.to.replace('@c.us', '');
        if (!botIsSendingTo.has(numLimpoMsg)) {
            const leads = carregarLeads();
            const fIdx = leads.findIndex(f => f.telefone === numLimpoMsg);
            if (fIdx >= 0 && leads[fIdx].status !== 'atendimento_humano') {
                leads[fIdx].status = 'atendimento_humano';
                salvarLeads(leads);
                sendLog(`[Intervenção] Humano assumiu atendimento com ${numLimpoMsg} no ${chipId}. Bot desativado.`, 'warning');
            }
        }
    });
}

async function initChipInstance(chipId) {
    const configs = carregarChipsConfig();
    const cfg = configs[chipId];
    if (!cfg || !cfg.enabled) {
        return;
    }

    if (chipInstances[chipId].client) {
        try {
            await chipInstances[chipId].client.destroy();
        } catch (e) {}
    }

    chipInstances[chipId].status = 'connecting';
    chipInstances[chipId].isReady = false;
    sendLog(`[${cfg.name}] Inicializando instância do WhatsApp (${cfg.clientId})...`, 'info');

    const client = createWppClient(cfg.clientId);
    chipInstances[chipId].client = client;

    registerChipEvents(chipId, client);
    registerChipMessageHandlers(chipId, client);

    try {
        await client.initialize();
    } catch (err) {
        sendLog(`[${cfg.name}] Falha na inicialização: ${err.message}`, 'error');
        chipInstances[chipId].status = 'disconnected';
    }
}

// ==========================================
// DETECTOR INTELIGENTE DE BOT & RESPOSTAS AUTOMÁTICAS
// ==========================================
function detectAutomatedReply(messageBody, leadRecord = null) {
    if (!messageBody || typeof messageBody !== 'string') return { isBot: false };
    
    const raw = messageBody.trim();
    const texto = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 1. Detecção por Latência Instantânea (Impossibilidade Biológica Humana)
    if (leadRecord && leadRecord.dataDisparo) {
        const tempoRespostaMs = Date.now() - new Date(leadRecord.dataDisparo).getTime();
        const tempoSegundos = tempoRespostaMs / 1000;

        if (tempoRespostaMs >= 0 && tempoSegundos <= 5) {
            return { 
                isBot: true, 
                razao: `Resposta instantânea de máquina (${tempoSegundos.toFixed(1)}s após o envio)` 
            };
        }

        if (tempoRespostaMs >= 0 && tempoSegundos <= 12 && (raw.length > 25 || raw.includes('\n'))) {
            return { 
                isBot: true, 
                razao: `Resposta automática rápida (${tempoSegundos.toFixed(1)}s com ${raw.length} caracteres)` 
            };
        }
    }
    
    // 2. Frases de Ausência e Boas-Vindas
    const padroesAusenciaSaudacao = [
        'no momento estou ausente',
        'no momento estamos ausentes',
        'estou ausente',
        'estamos ausentes',
        'responderei assim que possivel',
        'responderemos assim que possivel',
        'retornaremos assim que possivel',
        'retornarei assim que possivel',
        'logo que possivel responderemos',
        'assim que possivel entraremos em contato',
        'assim que possivel responderemos',
        'assim que possivel retornaremos',
        'agradecemos seu contato',
        'agradecemos o seu contato',
        'agradecemos o contato',
        'agradecemos sua mensagem',
        'agradecemos a sua mensagem',
        'obrigado por entrar em contato',
        'obrigada por entrar em contato',
        'obrigado pelo contato',
        'obrigada pelo contato',
        'mensagem automatica',
        'resposta automatica',
        'esta e uma mensagem automatica',
        'mensagem gerada automaticamente',
        'horario de atendimento',
        'nosso horario de atendimento',
        'nosso horario de funcionamento',
        'fora do horario comercial',
        'fora do nosso horario',
        'fora de expediente',
        'em breve responderemos',
        'em breve entraremos em contato',
        'em breve retornaremos',
        'logo responderemos',
        'deixe sua mensagem',
        'deixe seu recado',
        'atendente virtual',
        'assistente virtual',
        'atendimento virtual',
        'como posso ajudar',
        'como podemos ajudar',
        'em que posso ajudar',
        'em que podemos ajudar',
        'como podemos te ajudar',
        'como posso te ajudar',
        'como podemos lhe ajudar',
        'como posso lhe ajudar',
        'seja bem vindo',
        'seja bem vinda',
        'bem-vindo',
        'bem vindo ao nosso whatsapp'
    ];

    for (const padrao of padroesAusenciaSaudacao) {
        if (texto.includes(padrao)) {
            return { isBot: true, razao: `Mensagem de ausência/saudação detectada ("${padrao}")` };
        }
    }

    // 3. Menus Interativos / Chatbots URA
    const padroesMenu = [
        'qual a opcao',
        'qual opcao',
        'selecione uma opcao',
        'selecione a opcao',
        'escolha uma opcao',
        'escolha a opcao',
        'digite o numero',
        'digite o numero correspondente',
        'digite uma opcao',
        'digite a opcao desejada',
        'opcao desejada',
        'menu principal',
        'menu de opcoes',
        'para falar com',
        'digite 1 para',
        'digite 2 para',
        'digite 3 para',
        'digite 0 para',
        'setor de atendimento',
        'departamento financeiro'
    ];

    for (const menuFrase of padroesMenu) {
        if (texto.includes(menuFrase)) {
            return { isBot: true, razao: `Menu de chatbot/URA detectado ("${menuFrase}")` };
        }
    }

    // 4. Estrutura de Opções Numeradas (ex: 1. Agendar 2. Exames)
    const linhas = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let itensNumerados = 0;
    for (const linha of linhas) {
        if (/^(\*|\(|\[)?\d{1,2}[\.\)\-\]\:\s]/i.test(linha)) {
            itensNumerados++;
        }
    }

    if (itensNumerados >= 2) {
        return { isBot: true, razao: `Lista de menu automatizada detectada (${itensNumerados} opções numeradas)` };
    }

    // 5. Volume e Estrutura de Texto Anormal para 1ª resposta humana
    if (raw.length >= 280 || (raw.length >= 160 && linhas.length >= 3)) {
        return { 
            isBot: true, 
            razao: `Texto excessivamente longo/estruturado para primeira resposta (${raw.length} chars, ${linhas.length} parágrafos - característico de bot com delay)` 
        };
    }

    // 6. Marcadores de lista (bullet points)
    let bulletPoints = 0;
    for (const linha of linhas) {
        if (/^([•\-\*>]|\d+[\.\)\-])\s+/i.test(linha)) {
            bulletPoints++;
        }
    }
    if (bulletPoints >= 2) {
        return {
            isBot: true,
            razao: `Mensagem estruturada com lista de tópicos (${bulletPoints} marcadores detectados)`
        };
    }

    return { isBot: false };
}

function keywordMatch(textoLimpo, keyword) {
    const kw = keyword.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!kw) return false;

    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    
    if (!regex.test(textoLimpo)) return false;

    const afirmativas = ['sim', 'quero', 'tenho interesse', 'aceito', 'gostaria', 'fechar', 'comprar'];
    if (afirmativas.includes(kw)) {
        const regexNegacao = new RegExp(`(?:nao|nunca|jamais|nem)\\s+${escaped}`, 'i');
        if (regexNegacao.test(textoLimpo)) {
            return false;
        }
    }

    return true;
}

// ==========================================
// FUNÇÕES AUXILIARES & ANTI-BAN
// ==========================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sanitizarTelefone(rawPhone) {
    if (!rawPhone) return null;
    const str = String(rawPhone).trim();
    if (str.includes('') || str.toLowerCase().includes('rua') || str.toLowerCase().includes('av.') || str.toLowerCase().includes('porto alegre') || str.toLowerCase().includes('sarandi')) {
        return null;
    }
    let digits = str.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    
    if (digits.length === 10 || digits.length === 11) {
        digits = '55' + digits;
    }
    
    if (digits.length === 12 || digits.length === 13) {
        const ddd = parseInt(digits.substring(2, 4));
        if (digits.startsWith('55') && ddd >= 11 && ddd <= 99) {
            return digits;
        }
    }
    return null;
}

// Verificação de Horário Comercial Seguro (08:00 às 20:00)
function verificarHorarioComercial() {
    const agora = new Date();
    try {
        const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
        const hora = parseInt(formatter.format(agora), 10);
        if (hora >= 8 && hora < 20) {
            return { seguro: true, hora };
        }
        return { 
            seguro: false, 
            hora,
            motivo: `Fora do horário comercial seguro (08:00 às 20:00). Hora atual em Brasília: ${hora}h` 
        };
    } catch (e) {
        return { seguro: true };
    }
}

// ==========================================
// ALGORITMO ROUND-ROBIN DE SELEÇÃO DE CHIP
// ==========================================
let chipRotationIndex = 0;

function obterProximoChipDisponivel() {
    verificarResetDiarioChips();
    const configs = carregarChipsConfig();
    const chipKeys = ['chip_1', 'chip_2', 'chip_3', 'chip_4', 'chip_5'];
    const now = Date.now();

    const candidatos = [];
    for (const cid of chipKeys) {
        const cfg = configs[cid];
        const inst = chipInstances[cid];

        if (!cfg || !cfg.enabled) continue;
        if (!inst || !inst.isReady || !inst.client) continue;

        // Cota diária estourada?
        if (cfg.dailySent >= (cfg.dailyLimit || 40)) {
            continue;
        }

        // Em Coffee Break?
        if (cfg.inCoffeeBreakUntil) {
            const breakTime = new Date(cfg.inCoffeeBreakUntil).getTime();
            if (breakTime > now) {
                continue;
            } else {
                // Terminou a pausa
                cfg.inCoffeeBreakUntil = null;
                cfg.sentSinceLastBreak = 0;
                salvarChipsConfig(configs);
                sendLog(`[☕ Coffee Break Finalizado] ${cfg.name} voltou à ativa para envios!`, 'system');
            }
        }

        candidatos.push(cid);
    }

    if (candidatos.length === 0) {
        return null;
    }

    chipRotationIndex = (chipRotationIndex + 1) % candidatos.length;
    const selectedChipId = candidatos[chipRotationIndex];
    return { chipId: selectedChipId, config: configs[selectedChipId], instance: chipInstances[selectedChipId] };
}

// ==========================================
// MOTOR DE DISPARO POR CHIP COM DIGITAÇÃO HUMANA
// ==========================================
const enviarMensagemComChip = async (chipId, telefone, nome, templateMsg, campanhaId, metadata = null, isFollowup = false, attempt = 1) => {
    const instance = chipInstances[chipId];
    if (!instance || !instance.isReady || !instance.client) {
        sendLog(`Falha -> ${nome}: Chip [${chipId}] não está pronto/conectado.`, 'error');
        return false;
    }

    const primeiroNome = nome ? nome.split(' ')[0] : 'lá';
    // 1. Spintax: {Olá|Oi|Bom dia}
    let textoFinal = parseSpintax(templateMsg);
    // 2. {nome}
    textoFinal = textoFinal.replace(/{nome}/gi, primeiroNome);
    // 3. Metadados dinâmicos
    if (metadata) {
        for (const key in metadata) {
            const regex = new RegExp(`{${key}}`, 'gi');
            textoFinal = textoFinal.replace(regex, metadata[key] || '');
        }
    }

    const telLimpo = sanitizarTelefone(telefone);
    if (!telLimpo) {
        sendLog(`Falha -> ${nome}: Telefone inválido ou não informado (${telefone}).`, 'error');
        return false;
    }

    const numeroFormatado = `${telLimpo}@c.us`;

    try {
        const client = instance.client;
        const contactId = await client.getNumberId(numeroFormatado);
        if (!contactId) {
            sendLog(`Falha -> ${nome}: Número não registrado no WhatsApp (${telLimpo}).`, 'error');
            return false;
        }

        const destinoFinal = contactId._serialized;
        const numLimpoDestino = destinoFinal.replace('@c.us', '');

        botIsSendingTo.add(numLimpoDestino);

        // Simulação realista de digitação humana
        try {
            const chat = await client.getChatById(destinoFinal);
            if (chat) {
                await chat.sendStateTyping();
                const tempoDigitacao = Math.min(4500, Math.max(1800, Math.floor(textoFinal.length * 30)));
                await sleep(tempoDigitacao);
                await chat.clearState();
            }
        } catch (tErr) {}

        await client.sendMessage(destinoFinal, textoFinal);
        setTimeout(() => botIsSendingTo.delete(numLimpoDestino), 5000);

        const chipCfg = carregarChipsConfig()[chipId] || { name: chipId };
        sendLog(`Sucesso -> ${nome} [via ${chipCfg.name}]`, 'success');

        if (!isFollowup) {
            const leads = carregarLeads();
            const fIdx = leads.findIndex(f => 
                f.telefone === telLimpo || 
                f.telefone === telefone || 
                f.lid === numLimpoDestino || 
                f.telefone === numLimpoDestino ||
                (metadata && metadata.id && f.leadId === metadata.id)
            );
            
            const registroLead = {
                telefone: telLimpo,
                lid: numLimpoDestino,
                telefoneOriginal: telefone,
                leadId: metadata && metadata.id ? metadata.id : null,
                nome: nome,
                dataDisparo: new Date().toISOString(),
                status: 'aguardando_resposta',
                campanhaId: campanhaId,
                enviadoPorChip: chipId
            };

            if (fIdx >= 0) {
                leads[fIdx] = { ...leads[fIdx], ...registroLead };
            } else {
                leads.push(registroLead);
            }
            salvarLeads(leads);

            // Marca no campaigns.json
            if (campanhaId) {
                try {
                    const campaigns = carregarCampaigns();
                    if (campaigns[campanhaId]) {
                        campaigns[campanhaId].enviados = campaigns[campanhaId].enviados || [];
                        if (!campaigns[campanhaId].enviados.includes(telLimpo)) {
                            campaigns[campanhaId].enviados.push(telLimpo);
                        }
                        if (campaigns[campanhaId].contatos) {
                            const cIdx = campaigns[campanhaId].contatos.findIndex(c => 
                                c.telefone === telLimpo || 
                                c.telefone === telefone || 
                                (c.nome && c.nome.trim().toLowerCase() === nome.trim().toLowerCase())
                            );
                            if (cIdx >= 0) {
                                campaigns[campanhaId].contatos[cIdx].enviado = true;
                                campaigns[campanhaId].contatos[cIdx].dataEnvio = registroLead.dataDisparo;
                                campaigns[campanhaId].contatos[cIdx].enviadoPorChip = chipId;
                            }
                        }
                        salvarCampaigns(campaigns);
                    }
                } catch (e) {
                    console.error('Erro ao atualizar flag de enviado na campanha:', e);
                }
            }
        }

        return true;

    } catch (error) {
        const errorMsg = (error && error.message) ? error.message : String(error);
        const isDetached = errorMsg.includes('detached Frame') || errorMsg.includes('Execution context was destroyed') || errorMsg.includes('Session closed');

        if (isDetached && attempt < 2) {
            sendLog(`⚠️ [Auto-Recuperação] Frame desanexado no ${chipId}. Tentando recarregar contexto...`, 'warning');
            try {
                if (instance.client && instance.client.pupPage) {
                    await instance.client.pupPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                }
            } catch (reloadErr) {}
            await sleep(5000);
            return await enviarMensagemComChip(chipId, telefone, nome, templateMsg, campanhaId, metadata, isFollowup, attempt + 1);
        }

        sendLog(`Falha -> ${nome} [${chipId}]: ${errorMsg}`, 'error');
        return false;
    }
};

// Wrapper para manter compatibilidade com follow-ups e chamadas genéricas
const enviarMensagem = async (telefone, nome, templateMsg, campanhaId, metadata = null, isFollowup = false) => {
    const chipApto = obterProximoChipDisponivel();
    if (!chipApto) {
        sendLog('Falha: Nenhum chip disponível/conectado no momento.', 'error');
        return false;
    }
    return await enviarMensagemComChip(chipApto.chipId, telefone, nome, templateMsg, campanhaId, metadata, isFollowup);
};

// ==========================================
// FILA ÚNICA CENTRAL COM ROUND-ROBIN DE CAMPANHAS
// ==========================================
let isGlobalQueueRunning = false;
let globalCampaignIndex = 0;
let globalQueueStatus = {
    status: 'idle',
    currentCampaignName: null,
    currentLeadName: null,
    currentChipName: null,
    lastSentAt: null,
    nextSendAt: null,
    totalActiveCampaigns: 0,
    totalPendingLeads: 0
};

function getActiveCampaignsWithPendingLeads() {
    const campaigns = carregarCampaigns();
    const knownLeads = carregarLeads();
    const activeList = [];

    for (const cid in campaigns) {
        const camp = campaigns[cid];
        if (camp.status !== 'running') continue;

        let contatos = (camp.contatos || []).map(c => ({
            ...c,
            telefone: sanitizarTelefone(c.telefone || c.phone)
        })).filter(c => c.telefone !== null);

        const campEnviados = new Set(camp.enviados || []);

        const pendentes = contatos.filter(c => {
            if (c.enviado) return false;
            if (campEnviados.has(c.telefone)) return false;

            const jaEnviado = knownLeads.some(kl => {
                if (kl.telefone === c.telefone) return true;
                if (kl.lid && (kl.lid === c.telefone || kl.lid === c.lid)) return true;
                if (kl.leadId && c.metadata && c.metadata.id && kl.leadId === c.metadata.id) return true;
                if (kl.telefone && c.telefone) {
                    const klDig = kl.telefone.replace(/\D/g, '');
                    const cDig = c.telefone.replace(/\D/g, '');
                    if (klDig.length >= 8 && cDig.length >= 8) {
                        if (klDig === cDig || klDig.endsWith(cDig.slice(-8)) || cDig.endsWith(klDig.slice(-8))) {
                            return true;
                        }
                    }
                }
                if (kl.nome && c.nome && kl.nome.trim().toLowerCase() === c.nome.trim().toLowerCase() && kl.campanhaId === cid) {
                    return true;
                }
                return false;
            });

            return !jaEnviado;
        });

        if (pendentes.length > 0) {
            activeList.push({ id: cid, campaign: camp, pendentes });
        } else {
            campaigns[cid].status = 'finished';
            salvarCampaigns(campaigns);
            sendLog(`--- CAMPANHA FINALIZADA: ${camp.name} ---`, 'system');
        }
    }

    return activeList;
}

async function loopFilaGlobal() {
    if (isGlobalQueueRunning) return;
    isGlobalQueueRunning = true;
    sendLog('🚦 [Motor Central Anti-Ban] Fila Única Central iniciada.', 'system');

    while (true) {
        try {
            verificarResetDiarioChips();

            const activeCamps = getActiveCampaignsWithPendingLeads();
            globalQueueStatus.totalActiveCampaigns = activeCamps.length;
            globalQueueStatus.totalPendingLeads = activeCamps.reduce((acc, c) => acc + c.pendentes.length, 0);

            if (activeCamps.length === 0) {
                globalQueueStatus.status = 'idle';
                globalQueueStatus.currentCampaignName = null;
                globalQueueStatus.currentLeadName = null;
                await sleep(3000);
                continue;
            }

            // Checagem de Horário Comercial
            const checkHorario = verificarHorarioComercial();
            if (!checkHorario.seguro) {
                globalQueueStatus.status = 'paused_outside_business_hours';
                sendLog(`🌙 [Fila Global em Espera] ${checkHorario.motivo}. Disparos noturnos pausados para evitar ban.`, 'warning');
                await sleep(60000);
                continue;
            }

            // Intercalação Round-Robin de Campanhas
            globalCampaignIndex = globalCampaignIndex % activeCamps.length;
            const currentItem = activeCamps[globalCampaignIndex];
            const currentCamp = currentItem.campaign;
            const lead = currentItem.pendentes[0];

            // Seleção de Chip Disponível
            const chipDisponivel = obterProximoChipDisponivel();
            if (!chipDisponivel) {
                globalQueueStatus.status = 'waiting_chips';
                const configs = carregarChipsConfig();
                let menorTempoRestanteMs = 60000;
                const now = Date.now();

                for (const cid in configs) {
                    if (configs[cid].enabled && configs[cid].inCoffeeBreakUntil) {
                        const diff = new Date(configs[cid].inCoffeeBreakUntil).getTime() - now;
                        if (diff > 0 && diff < menorTempoRestanteMs) {
                            menorTempoRestanteMs = diff;
                        }
                    }
                }

                sendLog(`⏳ [Fila Global] Nenhum chip disponível no momento (em coffee break, limite atingido ou desconectados). Aguardando liberação...`, 'warning');
                await sleep(Math.min(30000, Math.max(10000, menorTempoRestanteMs)));
                continue;
            }

            const { chipId, config: chipCfg } = chipDisponivel;

            globalQueueStatus.status = 'sending';
            globalQueueStatus.currentCampaignName = currentCamp.name;
            globalQueueStatus.currentLeadName = lead.nome;
            globalQueueStatus.currentChipName = chipCfg.name;

            sendLog(`[Fila Global] [${currentCamp.name}] Lead: ${lead.nome} -> Disparando via ${chipCfg.name} (Envio diário: ${chipCfg.dailySent + 1}/${chipCfg.dailyLimit})...`, 'info');

            // Disparo
            const currentMessageBase = currentCamp.messageBase || "Oi {nome}, tudo bem?";
            const enviado = await enviarMensagemComChip(chipId, lead.telefone, lead.nome, currentMessageBase, currentItem.id, lead.metadata);

            // Atualiza estatísticas da campanha
            let allCamps = carregarCampaigns();
            if (allCamps[currentItem.id]) {
                if (enviado) {
                    allCamps[currentItem.id].sent = (allCamps[currentItem.id].sent || 0) + 1;
                } else {
                    allCamps[currentItem.id].errors = (allCamps[currentItem.id].errors || 0) + 1;
                }
                salvarCampaigns(allCamps);
            }

            // Atualiza cota e checagem de Coffee Break do Chip
            if (enviado) {
                const freshConfigs = carregarChipsConfig();
                if (freshConfigs[chipId]) {
                    freshConfigs[chipId].dailySent = (freshConfigs[chipId].dailySent || 0) + 1;
                    freshConfigs[chipId].sentSinceLastBreak = (freshConfigs[chipId].sentSinceLastBreak || 0) + 1;

                    const breakLimit = freshConfigs[chipId].coffeeBreakAfter || 6;
                    if (freshConfigs[chipId].sentSinceLastBreak >= breakLimit) {
                        const breakMinutes = Math.floor(Math.random() * (15 - 8 + 1)) + 8;
                        const breakUntil = new Date(Date.now() + breakMinutes * 60 * 1000).toISOString();
                        freshConfigs[chipId].inCoffeeBreakUntil = breakUntil;
                        freshConfigs[chipId].sentSinceLastBreak = 0;
                        sendLog(`[☕ Coffee Break Ativado] ${freshConfigs[chipId].name} atingiu ${breakLimit} envios consecutivos. Descansando por ${breakMinutes} minutos (até ${new Date(breakUntil).toLocaleTimeString('pt-BR')}) para blindagem anti-ban.`, 'warning');
                    }
                    salvarChipsConfig(freshConfigs);
                }
            }

            // Alterna para a próxima campanha na próxima rodada
            globalCampaignIndex = (globalCampaignIndex + 1) % activeCamps.length;

            // Cálculo do Delay Seguro
            // Base individual de segurança de cada chip: 60s a 120s
            // Delay global é escalado proporcionalmente ao número de chips prontos, com piso de 30s
            const totalChipsProntos = Object.keys(chipInstances).filter(k => chipInstances[k].isReady).length || 1;
            const baseMin = parseInt(DELAY_MIN_MS) || 60000;
            const baseMax = parseInt(DELAY_MAX_MS) || 120000;
            const randBaseDelay = Math.floor(Math.random() * (baseMax - baseMin + 1)) + baseMin;
            const globalDelay = Math.max(30000, Math.floor(randBaseDelay / Math.max(1, totalChipsProntos)));

            globalQueueStatus.status = 'waiting_delay';
            globalQueueStatus.lastSentAt = new Date().toISOString();
            globalQueueStatus.nextSendAt = new Date(Date.now() + globalDelay).toISOString();

            sendLog(`[Fila Global] Próximo disparo em ${(globalDelay / 1000).toFixed(0)}s (distribuído entre ${totalChipsProntos} chip(s) ativos)...`, 'info');

            const checkInterval = 2000;
            let waited = 0;
            while (waited < globalDelay) {
                await sleep(checkInterval);
                waited += checkInterval;
            }

        } catch (loopErr) {
            console.error('[ERRO LOOP FILA GLOBAL]', loopErr);
            await sleep(5000);
        }
    }
}

// ==========================================
// ROTAS DE API: CLUSTER DE CHIPS & FILA GLOBAL
// ==========================================
app.get('/api/chips', (req, res) => {
    verificarResetDiarioChips();
    const configs = carregarChipsConfig();
    const result = {};
    for (const cid in configs) {
        const inst = chipInstances[cid] || {};
        result[cid] = {
            ...configs[cid],
            isReady: inst.isReady || false,
            runtimeStatus: inst.status || 'disconnected',
            phone: inst.phone || configs[cid].phone || null,
            qrCode: inst.qrCode || null
        };
    }
    res.json(result);
});

app.post('/api/chips/:id/toggle', async (req, res) => {
    const { id } = req.params;
    const configs = carregarChipsConfig();
    if (!configs[id]) return res.status(404).json({ error: 'Chip não encontrado.' });

    configs[id].enabled = !configs[id].enabled;
    salvarChipsConfig(configs);

    if (configs[id].enabled) {
        sendLog(`[${configs[id].name}] Habilitado pelo usuário. Inicializando navegador...`, 'system');
        initChipInstance(id);
    } else {
        sendLog(`[${configs[id].name}] Desabilitado pelo usuário. Encerrando navegador...`, 'warning');
        if (chipInstances[id].client) {
            try { await chipInstances[id].client.destroy(); } catch (e) {}
            chipInstances[id].client = null;
            chipInstances[id].isReady = false;
            chipInstances[id].status = 'disconnected';
            chipInstances[id].qrCode = null;
        }
    }

    res.json({ success: true, chip: configs[id] });
});

app.post('/api/chips/:id/restart', async (req, res) => {
    const { id } = req.params;
    const configs = carregarChipsConfig();
    if (!configs[id]) return res.status(404).json({ error: 'Chip não encontrado.' });

    try {
        sendLog(`[${configs[id].name}] 🔄 Solicitada reconexão do WhatsApp...`, 'warning');
        const inst = chipInstances[id];
        if (inst && inst.client && inst.client.pupPage) {
            await inst.client.pupPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            sendLog(`[${configs[id].name}] Navegador recarregado. Aguardando sincronização...`, 'info');
        } else {
            await initChipInstance(id);
        }
        res.json({ success: true, message: `Chip ${configs[id].name} reiniciado.` });
    } catch (e) {
        sendLog(`[${configs[id].name}] Erro ao reiniciar: ${e.message}`, 'error');
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chips/:id/config', (req, res) => {
    const { id } = req.params;
    const { name, dailyLimit, coffeeBreakAfter } = req.body;
    const configs = carregarChipsConfig();
    if (!configs[id]) return res.status(404).json({ error: 'Chip não encontrado.' });

    if (name) configs[id].name = name;
    if (dailyLimit !== undefined) configs[id].dailyLimit = parseInt(dailyLimit) || 40;
    if (coffeeBreakAfter !== undefined) configs[id].coffeeBreakAfter = parseInt(coffeeBreakAfter) || 6;

    salvarChipsConfig(configs);
    sendLog(`[${configs[id].name}] Configurações atualizadas: Limite diário=${configs[id].dailyLimit}, Coffee break a cada=${configs[id].coffeeBreakAfter}.`, 'success');
    res.json({ success: true, chip: configs[id] });
});

app.get('/api/global-queue/status', (req, res) => {
    res.json(globalQueueStatus);
});

// Rotas Legadas de WhatsApp
app.get('/api/whatsapp/status', (req, res) => {
    const inst = chipInstances['chip_1'];
    if (inst && inst.isReady) {
        return res.json({ status: 'connected' });
    }
    if (inst && inst.qrCode) {
        return res.json({ status: 'qrcode', qrcode: inst.qrCode });
    }
    return res.json({ status: 'connecting', message: 'Iniciando WhatsApp Chip 1...' });
});

app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        const inst = chipInstances['chip_1'];
        if (inst && inst.client && inst.client.pupPage) {
            await inst.client.pupPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
            await initChipInstance('chip_1');
        }
        res.json({ success: true, message: 'Reconexão de Chip 1 iniciada.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// ROTAS DE FOLLOW-UPS & RETOMADA DE VÁCUO
// ==========================================
app.get('/api/followups', (req, res) => {
    const leads = carregarLeads();
    const pendentes = leads.filter(f => f.status === 'aguardando_resposta');
    const autoBots = leads.filter(f => f.status === 'resposta_automatica');
    const humanos = leads.filter(f => f.status === 'atendimento_humano');
    const respondidos = leads.filter(f => f.status === 'respondido');
    res.json({ 
        pendentes: pendentes.length,
        botsDetectados: autoBots.length,
        humanos: humanos.length,
        respondidos: respondidos.length
    });
});

app.post('/api/followups/start', (req, res) => {
    const chipApto = obterProximoChipDisponivel();
    if (!chipApto) return res.status(400).json({ error: 'Nenhum WhatsApp conectado ou disponível no momento!' });

    const leads = carregarLeads();
    const pendentes = leads.filter(f => f.status === 'aguardando_resposta');

    if (pendentes.length === 0) return res.status(400).json({ error: 'Nenhum lead aguardando resposta.' });

    res.json({ message: `Iniciando follow-up para ${pendentes.length} leads.` });

    (async () => {
        sendLog('--- INICIANDO FOLLOW-UPS MULTI-CHIP ---', 'system');
        const campaigns = carregarCampaigns();

        for (let i = 0; i < pendentes.length; i++) {
            const lead = pendentes[i];
            sendLog(`Resgatando [${i+1}/${pendentes.length}] ${lead.nome}...`, 'info');
            
            const camp = campaigns[lead.campanhaId];
            const msgVacuo = camp && camp.messageVacuo ? camp.messageVacuo : "Oi {nome}, conseguiu ver a mensagem acima?";

            const enviado = await enviarMensagem(lead.telefone, lead.nome, msgVacuo, lead.campanhaId, null, true);
            
            if (enviado) {
                const currentLeads = carregarLeads();
                const fIdx = currentLeads.findIndex(f => f.telefone === lead.telefone);
                if (fIdx >= 0) {
                    currentLeads[fIdx].status = 'cobrado';
                    salvarLeads(currentLeads);
                }
            }

            if (i < pendentes.length - 1) {
                const delay = 45000 + Math.floor(Math.random() * 45000);
                sendLog(`Aguardando ${(delay / 1000).toFixed(0)}s antes do próximo follow-up...`, 'info');
                await sleep(delay);
            }
        }
        sendLog('--- FOLLOW-UPS FINALIZADOS ---', 'system');
    })();
});

// ==========================================
// ROTAS DE GESTÃO DE CAMPANHAS
// ==========================================
app.get('/api/session', (req, res) => {
    const { email, vendorId } = getCrmSessionClient();
    res.json({ email: email || null, user_id: vendorId || null });
});

app.get('/api/searches', async (req, res) => {
    const { client, vendorId, error: sessErr } = getCrmSessionClient();
    if (!client) {
        return res.status(400).json({ error: sessErr || 'Sessão do CRM não configurada. Faça login no Lead Hunter.' });
    }
    
    try {
        let { data, error } = await client
            .from('scraped_searches')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (vendorId && Array.isArray(data)) {
            const userSpecific = data.filter(s => s.user_id === vendorId);
            if (userSpecific.length > 0) {
                data = userSpecific;
            }
        }
            
        res.json(data || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/campaigns', (req, res) => {
    res.json(carregarCampaigns());
});

app.post('/api/campaign/pause', (req, res) => {
    const { id } = req.body;
    const campaigns = carregarCampaigns();
    if (campaigns[id]) {
        campaigns[id].status = 'paused';
        salvarCampaigns(campaigns);
        sendLog(`Campanha [${campaigns[id].name}] pausada.`, 'warning');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Campanha não encontrada.' });
    }
});

app.post('/api/campaign/resume', (req, res) => {
    const { id } = req.body;
    const campaigns = carregarCampaigns();
    if (campaigns[id]) {
        campaigns[id].status = 'running';
        salvarCampaigns(campaigns);
        sendLog(`Campanha [${campaigns[id].name}] retomada. Incluída na Fila Única Central.`, 'success');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Campanha não encontrada.' });
    }
});

app.post('/api/campaign/stop', (req, res) => {
    const { id } = req.body;
    const campaigns = carregarCampaigns();
    if (campaigns[id]) {
        campaigns[id].status = 'stopped';
        salvarCampaigns(campaigns);
        sendLog(`Campanha [${campaigns[id].name}] cancelada/parada.`, 'error');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Campanha não encontrada.' });
    }
});

app.post('/api/campaign/update', (req, res) => {
    const { id, name, messageBase, messageVacuo, rules } = req.body;
    if (!id) return res.status(400).json({ error: 'ID da campanha é obrigatório.' });

    const campaigns = carregarCampaigns();
    if (!campaigns[id]) {
        return res.status(404).json({ error: 'Campanha não encontrada.' });
    }

    if (name) campaigns[id].name = name;
    if (messageBase !== undefined) campaigns[id].messageBase = messageBase;
    if (messageVacuo !== undefined) campaigns[id].messageVacuo = messageVacuo;
    if (rules !== undefined && Array.isArray(rules)) campaigns[id].rules = rules;

    salvarCampaigns(campaigns);
    sendLog(`[${campaigns[id].name}] ✏️ Copys e Regras atualizadas com sucesso! Os próximos envios já usarão os novos textos.`, 'success');

    res.json({ success: true, campaign: campaigns[id] });
});

app.post('/api/campaign/start', async (req, res) => {
    const configs = carregarChipsConfig();
    const hasAnyActiveChip = Object.keys(chipInstances).some(cid => chipInstances[cid].isReady || (configs[cid] && configs[cid].enabled));
    if (!hasAnyActiveChip) {
        return res.status(400).json({ error: 'Nenhum chip WhatsApp está habilitado ou conectado!' });
    }

    const searchId = req.body.searchId;
    const campaignName = req.body.campaignName || "Campanha Genérica";
    const messageBase = req.body.messageBase || "Oi {nome}, tudo bem?";
    const messageVacuo = req.body.messageVacuo || "Oi {nome}, conseguiu ler a mensagem acima?";
    
    let rules = [];
    try { rules = JSON.parse(req.body.botRulesJson || '[]'); } catch(e){}

    let contatos = [];
    const isCsvTest = (req.body.csvLeads && Array.isArray(req.body.csvLeads) && req.body.csvLeads.length > 0) || (req.files && req.files.csvFile) || searchId === 'csv_test';

    if (isCsvTest) {
        if (req.body.csvLeads && Array.isArray(req.body.csvLeads)) {
            contatos = req.body.csvLeads.map(l => ({
                nome: l.nome || l.name || 'Cliente',
                telefone: sanitizarTelefone(l.telefone || l.phone),
                metadata: l.metadata || { ...l }
            })).filter(c => c.telefone !== null);
        } else if (req.files && req.files.csvFile) {
            const fileContent = req.files.csvFile.data.toString('utf-8');
            const parsed = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
            contatos = (parsed.data || []).map(row => {
                const nome = row.Nome || row.nome || row.name || row.Name || 'Cliente';
                const tel = sanitizarTelefone(row.Telefone || row.telefone || row.phone || row.Phone || '');
                return {
                    nome,
                    telefone: tel,
                    metadata: { ...row, endereco: row.Endereço || row.endereco || '', nota: row.Nota || row.nota || '' }
                };
            }).filter(c => c.telefone !== null);
        }

        if (contatos.length === 0) return res.status(400).json({ error: 'Nenhum lead com telefone válido encontrado no CSV.' });
    } else {
        const { client, vendorId, error: sessErr } = getCrmSessionClient();
        if (!client || !vendorId) return res.status(400).json({ error: sessErr || 'Sessão CRM inválida.' });

        if (!searchId) return res.status(400).json({ error: 'ID do Pacote de Leads é obrigatório.' });

        const { data: scrapedLeads, error } = await client
            .from('scraped_leads')
            .select('*')
            .eq('search_id', searchId)
            .eq('user_id', vendorId)
            .not('phone', 'is', null)
            .neq('phone', '')
            .gt('score', 0);

        if (error) return res.status(500).json({ error: 'Erro ao buscar leads no CRM: ' + error.message });
        
        contatos = (scrapedLeads || []).map(l => ({
            nome: l.name,
            telefone: sanitizarTelefone(l.phone),
            metadata: { ...l, endereco: l.address, nota: l.rating }
        })).filter(c => c.telefone !== null);

        if (contatos.length === 0) return res.status(400).json({ error: 'Nenhum lead com telefone válido encontrado neste pacote.' });

        // Deduplicação
        const knownLeads = carregarLeads();
        contatos = contatos.filter(c => !knownLeads.some(kl => {
            if (kl.telefone === c.telefone) return true;
            if (kl.leadId && c.metadata && c.metadata.id && kl.leadId === c.metadata.id) return true;
            return false;
        }));

        if (contatos.length === 0) return res.status(400).json({ error: 'Todos os leads deste pacote já foram contatados anteriormente.' });
    }

    const campanhaId = 'camp_' + Date.now();

    const campaigns = carregarCampaigns();
    campaigns[campanhaId] = { 
        id: campanhaId,
        searchId: searchId || null,
        contatos: contatos,
        name: campaignName, 
        messageBase, 
        messageVacuo, 
        rules,
        status: 'running',
        total: contatos.length,
        sent: 0,
        errors: 0,
        started_at: new Date().toISOString()
    };
    salvarCampaigns(campaigns);

    sendLog(`Campanha [${campaignName}] criada e injetada na Fila Única Central com ${contatos.length} leads inéditos.`, 'success');
    res.json({ message: `Campanha [${campaignName}] iniciada para ${contatos.length} leads inéditos.`, id: campanhaId });
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR & MOTORES
// ==========================================
app.listen(PORT, async () => {
    console.log(`[!] Painel Frontend: http://localhost:${PORT}`);
    
    // Inicia instâncias dos chips que estão habilitados
    verificarResetDiarioChips();
    const configs = carregarChipsConfig();
    for (const cid in configs) {
        if (configs[cid].enabled) {
            initChipInstance(cid);
        }
    }

    // Inicia a Fila Central Anti-Ban em segundo plano
    setTimeout(() => {
        loopFilaGlobal();
    }, 4000);
});
