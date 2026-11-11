@echo off
title Maquina de Vendas - Iniciador
echo Iniciando Maquina de Vendas WPP...
echo.

cd /d "C:\maquina-vendas-wpp"

echo [1/2] Iniciando conteineres Docker (Evolution API, Banco de Dados, Redis)...
docker-compose up -d
echo.

echo [2/2] Iniciando o servidor Node.js (Backend e Webhook)...
cd script-node
node app.js

pause
