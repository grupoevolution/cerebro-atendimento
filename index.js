/**
 * CÉREBRO DE ATENDIMENTO v3.1 - Sistema Principal CORRIGIDO
 * Sistema robusto de atendimento automatizado via WhatsApp
 * Integra Perfect Pay, Evolution API, N8N com PostgreSQL
 * 
 * CORREÇÕES APLICADAS:
 * ✅ Verificação final (25min) removida completamente
 * ✅ Verificação de pagamento antes de processar respostas
 * ✅ Sistema de resposta única implementado
 * ✅ Normalização de telefone consistente
 * ✅ Logs de debug adicionados
 * ✅ Validações de inicialização
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const moment = require('moment-timezone');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Importar módulos do sistema
const database = require('./database/config');
const evolutionService = require('./services/evolution');
const queueService = require('./services/queue');
const logger = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares de segurança
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configurações globais
const CONFIG = {
    PIX_TIMEOUT: parseInt(process.env.PIX_TIMEOUT) || 420000,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n',
    EVOLUTION_API_URL: process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun',
    MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3
};

// Mapeamento de produtos
const PRODUCT_MAPPING = {
    'PPLQQM9AP': 'FAB',
    'PPLQQMAGU': 'FAB', 
    'PPLQQMADF': 'FAB',
    'PPLQQN0FT': 'NAT',
    'PPLQQMSFH': 'CS',
    'PPLQQMSFI': 'CS'
};

// Instâncias Evolution API (GABY01 a GABY09)
const INSTANCES = [
    { name: 'GABY01', id: '1CEBB8703497-4F31-B33F-335A4233D2FE', active: true },
    { name: 'GABY02', id: '939E26DEA1FA-40D4-83CE-2BF0B3F795DC', active: true },
    { name: 'GABY03', id: 'F819629B5E33-435B-93BB-091B4C104C12', active: true },
    { name: 'GABY04', id: 'D555A7CBC0B3-425B-8E20-975232BE75F6', active: true },
    { name: 'GABY05', id: 'D97A63B8B05B-430E-98C1-61977A51EC0B', active: true },
    { name: 'GABY06', id: '6FC2C4C703BA-4A8A-9B3B-21536AE51323', active: true },
    { name: 'GABY07', id: '14F637AB35CD-448D-BF66-5673950FBA10', active: true },
    { name: 'GABY08', id: '82E0CE5B1A51-4B7B-BBEF-77D22320B482', active: true },
    { name: 'GABY09', id: 'B5783C928EF4-4DB0-ABBA-AF6913116E7B', active: true }
];

// Variáveis globais para controle de sistema
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

// Função para obter horário de Brasília
function getBrazilTime(format = 'YYYY-MM-DD HH:mm:ss') {
    return moment().tz('America/Sao_Paulo').format(format);
}

// Função para extrair produto do código do plano
function getProductByPlanCode(planCode) {
    return PRODUCT_MAPPING[planCode] || 'UNKNOWN';
}

// Função para extrair primeiro nome
function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0].trim() : 'Cliente';
}

// NOVA FUNÇÃO - Normalizar telefone consistentemente
function normalizePhoneNumber(phone) {
    if (!phone) return phone;
    
    // Remover caracteres não numéricos
    let cleanPhone = phone.replace(/\D/g, '');
    
    // Padronizar para formato: 5511999999999 (sem o 9 extra)
    if (cleanPhone.length === 14 && cleanPhone.substring(4, 5) === '9') {
        cleanPhone = cleanPhone.substring(0, 4) + cleanPhone.substring(5);
    }
    
    logger.debug(`Telefone normalizado: ${phone} → ${cleanPhone}`);
    return cleanPhone;
}

// FUNÇÃO CORRIGIDA - Formatar telefone
function formatPhoneNumber(extension, areaCode, number) {
    const ext = extension || '55';
    const area = areaCode || '';
    const num = number || '';
    
    let fullNumber = ext + area + num;
    
    // Normalizar usando a função consistente
    return normalizePhoneNumber(fullNumber);
}

// Função para obter instância sticky por lead
async function getInstanceForClient(clientNumber) {
    try {
        const normalizedPhone = normalizePhoneNumber(clientNumber);
        logger.info(`Verificando instância para cliente: ${normalizedPhone}`);
        
        const existingLead = await database.query(
            'SELECT instance_name FROM leads WHERE phone = $1',
            [normalizedPhone]
        );
        
        if (existingLead.rows.length > 0) {
            const instanceName = existingLead.rows[0].instance_name;
            logger.info(`Cliente ${normalizedPhone} já atribuído à instância ${instanceName}`);
            return instanceName;
        }
        
        const instanceLoad = await database.query(`
            SELECT instance_name, COUNT(*) as lead_count 
            FROM leads 
            GROUP BY instance_name
            ORDER BY lead_count ASC
        `);
        
        let selectedInstance;
        
        if (instanceLoad.rows.length === 0) {
            selectedInstance = 'GABY01';
        } else {
            const currentLoads = {};
            instanceLoad.rows.forEach(row => {
                currentLoads[row.instance_name] = parseInt(row.lead_count);
            });
            
            let minLoad = Infinity;
            for (const instance of INSTANCES) {
                if (!instance.active) continue;
                
                const load = currentLoads[instance.name] || 0;
                if (load < minLoad) {
                    minLoad = load;
                    selectedInstance = instance.name;
                }
            }
        }
        
        await database.query(
            'INSERT INTO leads (phone, instance_name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET instance_name = $2, updated_at = NOW()',
            [normalizedPhone, selectedInstance]
        );
        
        logger.info(`Cliente ${normalizedPhone} atribuído à instância ${selectedInstance}`);
        return selectedInstance;
        
    } catch (error) {
        logger.error(`Erro ao exportar contatos: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para listar instâncias disponíveis
app.get('/contacts/instances', async (req, res) => {
    try {
        const instances = await database.query(`
            SELECT instance_name, COUNT(*) as total
            FROM leads 
            GROUP BY instance_name 
            ORDER BY total DESC
        `);
        
        res.json({
            instances: instances.rows,
            total: instances.rows.reduce((sum, inst) => sum + parseInt(inst.total), 0)
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ENDPOINTS DE TESTE
app.post('/test/webhook', async (req, res) => {
    try {
        const { tipo, telefone } = req.body;
        const testPhone = normalizePhoneNumber(telefone || '5511999887766');
        const testOrder = 'TEST-' + Date.now();
        
        let eventData = {};
        
        switch (tipo) {
            case 'venda_aprovada':
                eventData = {
                    event_type: 'venda_aprovada',
                    produto: 'FAB',
                    instancia: 'GABY01',
                    evento_origem: 'aprovada',
                    cliente: {
                        nome: 'João',
                        telefone: testPhone,
                        nome_completo: 'João Silva Teste'
                    },
                    pedido: {
                        codigo: testOrder,
                        valor: 297.00
                    },
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    teste: true
                };
                break;
                
            case 'pix_timeout':
                eventData = {
                    event_type: 'pix_timeout',
                    produto: 'FAB',
                    instancia: 'GABY01',
                    evento_origem: 'pix',
                    cliente: {
                        nome: 'Maria',
                        telefone: testPhone,
                        nome_completo: 'Maria Santos Teste'
                    },
                    pedido: {
                        codigo: testOrder,
                        valor: 297.00,
                        pix_url: 'https://exemplo.com/pix'
                    },
                    timeout_minutos: 7,
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    teste: true
                };
                break;
                
            case 'resposta_01':
            case 'resposta_02':
            case 'resposta_03':
                const numeroResposta = tipo.split('_')[1];
                eventData = {
                    event_type: tipo,
                    produto: 'FAB',
                    instancia: 'GABY01',
                    evento_origem: 'aprovada',
                    cliente: {
                        telefone: testPhone,
                        nome: 'Carlos',
                        nome_completo: 'Carlos Teste'
                    },
                    resposta: {
                        numero: parseInt(numeroResposta),
                        conteudo: `Resposta teste ${numeroResposta}`,
                        timestamp: new Date().toISOString(),
                        brazil_time: getBrazilTime()
                    },
                    pedido: {
                        codigo: testOrder,
                        valor: 297.00
                    },
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    teste: true
                };
                break;
                
            case 'convertido':
                eventData = {
                    event_type: 'convertido',
                    produto: 'FAB',
                    instancia: 'GABY01',
                    evento_origem: 'pix_convertido',
                    cliente: {
                        telefone: testPhone,
                        nome: 'Ana',
                        nome_completo: 'Ana Convertida Teste'
                    },
                    conversao: {
                        resposta_numero: 2,
                        conteudo_resposta: 'Resposta que resultou em conversão',
                        valor_original: 297.00,
                        timestamp: new Date().toISOString(),
                        brazil_time: getBrazilTime()
                    },
                    pedido: {
                        codigo: testOrder,
                        valor: 297.00
                    },
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    teste: true
                };
                break;
                
            default:
                return res.status(400).json({ error: 'Tipo de teste inválido' });
        }
        
        logger.info(`Teste ${tipo} sendo enviado para N8N:`, eventData);
        
        const response = await axios.post(CONFIG.N8N_WEBHOOK_URL, eventData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        
        res.json({
            success: true,
            message: `Teste ${tipo} enviado com sucesso`,
            status: response.status,
            order_code: testOrder,
            normalized_phone: testPhone
        });
        
    } catch (error) {
        logger.error(`Erro no teste: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/test', (req, res) => {
    res.send(`
    <html><body style="font-family: Arial; padding: 20px;">
        <h2>🧪 Testes do Sistema N8N - v3.1 CORRIGIDO</h2>
        <p>Sistema com verificações corrigidas e logs de debug</p>
        <button onclick="enviarTeste('venda_aprovada')">✅ Testar Venda Aprovada</button><br><br>
        <button onclick="enviarTeste('pix_timeout')">⏰ Testar PIX Timeout (7 min)</button><br><br>
        <button onclick="enviarTeste('resposta_01')">1️⃣ Testar Resposta 01</button><br><br>
        <button onclick="enviarTeste('resposta_02')">2️⃣ Testar Resposta 02</button><br><br>
        <button onclick="enviarTeste('resposta_03')">3️⃣ Testar Resposta 03</button><br><br>
        <button onclick="enviarTeste('convertido')">💰 Testar Convertido (PIX→Pago)</button><br><br>
        <hr>
        <p><strong>NOVIDADES v3.1:</strong></p>
        <ul>
            <li>✅ Normalização telefone consistente</li>
            <li>✅ Verificação pagamento automática</li>
            <li>✅ Sistema resposta única</li>
            <li>❌ Verificação final REMOVIDA</li>
            <li>📊 Logs debug completos</li>
        </ul>
        <script>
        async function enviarTeste(tipo) {
            const telefone = prompt('Telefone para teste (ou deixe vazio):') || '5511999887766';
            console.log('Enviando teste:', tipo, 'para telefone:', telefone);
            
            try {
                const response = await fetch('/test/webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tipo, telefone })
                });
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ Teste enviado com sucesso!\\n\\n' + 
                          'Tipo: ' + tipo + '\\n' +
                          'Pedido: ' + result.order_code + '\\n' +
                          'Telefone: ' + result.normalized_phone);
                } else {
                    alert('❌ Erro: ' + result.error);
                }
            } catch (error) {
                alert('❌ Erro na requisição: ' + error.message);
                console.error('Erro:', error);
            }
        }
        </script>
    </body></html>
    `);
});

// NOVO ENDPOINT - Diagnóstico do sistema (problema 10)
app.get('/diagnostics', async (req, res) => {
    try {
        logger.info('Executando diagnóstico completo do sistema...');
        
        const diagnostics = {
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            system_version: '3.1-CORRECTED',
            
            // Status dos componentes
            components: {
                database: {
                    status: database.isConnected() ? 'connected' : 'disconnected',
                    details: database.isConnected() ? 'PostgreSQL conectado' : 'PostgreSQL desconectado'
                },
                n8n: {
                    status: 'configured',
                    url: CONFIG.N8N_WEBHOOK_URL,
                    details: 'URL configurada, teste necessário'
                },
                evolution: {
                    status: 'configured',
                    url: CONFIG.EVOLUTION_API_URL,
                    details: 'URL configurada, verificação de instâncias necessária'
                }
            },
            
            // Configurações atuais (sem senhas)
            configuration: {
                pix_timeout: `${CONFIG.PIX_TIMEOUT}ms (${Math.round(CONFIG.PIX_TIMEOUT/60000)} minutos)`,
                max_retry_attempts: CONFIG.MAX_RETRY_ATTEMPTS,
                port: PORT,
                node_env: process.env.NODE_ENV || 'development',
                instances_configured: INSTANCES.length
            },
            
            // Últimos erros (se houver)
            recent_errors: [],
            
            // Sugestões de correção
            suggestions: []
        };
        
        // Verificar problemas e sugestões
        if (!database.isConnected()) {
            diagnostics.components.database.status = 'error';
            diagnostics.suggestions.push({
                issue: 'Banco de dados desconectado',
                solution: 'Verificar credenciais do .env e conectividade PostgreSQL'
            });
        }
        
        // Verificar se .env existe
        const envExists = fs.existsSync(path.join(process.cwd(), '.env'));
        if (!envExists) {
            diagnostics.suggestions.push({
                issue: 'Arquivo .env não encontrado',
                solution: 'Criar arquivo .env baseado no .env.example com credenciais reais'
            });
        }
        
        // Verificar variáveis obrigatórias
        const requiredVars = ['DATABASE_URL', 'N8N_WEBHOOK_URL', 'EVOLUTION_API_URL'];
        const missingVars = requiredVars.filter(varName => !process.env[varName]);
        
        if (missingVars.length > 0) {
            diagnostics.suggestions.push({
                issue: `Variáveis obrigatórias ausentes: ${missingVars.join(', ')}`,
                solution: 'Configurar todas as variáveis obrigatórias no arquivo .env'
            });
        }
        
        // Testar conectividade básica se possível
        try {
            if (database.isConnected()) {
                const testQuery = await database.query('SELECT NOW() as current_time');
                diagnostics.components.database.last_test = testQuery.rows[0].current_time;
                diagnostics.components.database.details = 'PostgreSQL funcionando corretamente';
            }
        } catch (error) {
            diagnostics.components.database.status = 'error';
            diagnostics.components.database.error = error.message;
            diagnostics.recent_errors.push({
                component: 'database',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        
        // Obter estatísticas se banco estiver funcionando
        if (database.isConnected()) {
            try {
                const stats = await database.getStats();
                diagnostics.database_stats = stats;
            } catch (error) {
                diagnostics.recent_errors.push({
                    component: 'database_stats',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        // Status geral
        const hasErrors = diagnostics.recent_errors.length > 0 || !database.isConnected();
        diagnostics.overall_status = hasErrors ? 'warning' : 'healthy';
        
        logger.info(`Diagnóstico completo: ${diagnostics.overall_status} | ${diagnostics.suggestions.length} sugestões`);
        
        res.json(diagnostics);
        
    } catch (error) {
        logger.error(`Erro no diagnóstico: ${error.message}`, error);
        res.status(500).json({
            error: error.message,
            overall_status: 'error',
            suggestions: [{
                issue: 'Erro interno no diagnóstico',
                solution: 'Verificar logs do sistema para mais detalhes'
            }]
        });
    }
});

/**
 * VALIDAÇÕES DE INICIALIZAÇÃO (problema 9)
 */
async function validateSystemInitialization() {
    const errors = [];
    const warnings = [];
    
    logger.info('Executando validações de inicialização...');
    
    // 1. Verificar se .env existe (não .env.example)
    const envPath = path.join(process.cwd(), '.env');
    const envExamplePath = path.join(process.cwd(), '.env.example');
    
    if (!fs.existsSync(envPath)) {
        errors.push('Arquivo .env não encontrado. Crie baseado no .env.example com suas credenciais reais.');
        
        if (fs.existsSync(envExamplePath)) {
            logger.warn('Encontrado .env.example mas não .env. Você precisa criar o .env com credenciais reais.');
        }
    }
    
    // 2. Verificar variáveis obrigatórias
    const requiredVars = [
        'DATABASE_URL', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
        'N8N_WEBHOOK_URL', 'EVOLUTION_API_URL'
    ];
    
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        errors.push(`Variáveis obrigatórias ausentes no .env: ${missingVars.join(', ')}`);
    }
    
    // 3. Validar URLs
    try {
        new URL(CONFIG.N8N_WEBHOOK_URL);
    } catch (error) {
        errors.push(`N8N_WEBHOOK_URL inválida: ${CONFIG.N8N_WEBHOOK_URL}`);
    }
    
    try {
        new URL(CONFIG.EVOLUTION_API_URL);
    } catch (error) {
        errors.push(`EVOLUTION_API_URL inválida: ${CONFIG.EVOLUTION_API_URL}`);
    }
    
    // 4. Testar conexão com banco
    try {
        if (!database.isConnected()) {
            errors.push('Banco de dados não conectado. Verifique credenciais PostgreSQL.');
        } else {
            await database.query('SELECT 1');
            logger.info('✅ Conexão com PostgreSQL validada');
        }
    } catch (error) {
        errors.push(`Erro ao testar banco: ${error.message}`);
    }
    
    // 5. Testar pelo menos uma instância Evolution (apenas warning)
    try {
        const response = await axios.get(`${CONFIG.EVOLUTION_API_URL}/instance/connectionState/GABY01`, {
            timeout: 5000,
            headers: { 'apikey': INSTANCES[0].id }
        });
        
        if (response.status === 200) {
            logger.info('✅ Evolution API respondendo');
        }
    } catch (error) {
        warnings.push(`Evolution API pode estar offline: ${error.message}`);
    }
    
    // 6. Validar configurações de caracteres especiais na senha
    if (process.env.DB_PASSWORD && process.env.DB_PASSWORD.includes('@')) {
        warnings.push('Senha do banco contém @ - certifique-se de usar codificação URL se necessário');
    }
    
    // Resultado das validações
    if (errors.length > 0) {
        logger.error('❌ ERROS CRÍTICOS DE INICIALIZAÇÃO:');
        errors.forEach((error, index) => {
            logger.error(`${index + 1}. ${error}`);
        });
        
        logger.error('\n🔧 CORREÇÕES NECESSÁRIAS:');
        logger.error('1. Crie o arquivo .env (não use .env.example)');
        logger.error('2. Configure todas as variáveis obrigatórias');
        logger.error('3. Teste a conexão PostgreSQL manualmente');
        logger.error('4. Verifique URLs das APIs\n');
        
        throw new Error(`${errors.length} erro(s) crítico(s) de configuração encontrado(s)`);
    }
    
    if (warnings.length > 0) {
        logger.warn('⚠️ AVISOS DE INICIALIZAÇÃO:');
        warnings.forEach((warning, index) => {
            logger.warn(`${index + 1}. ${warning}`);
        });
    }
    
    logger.info('✅ Validações de inicialização concluídas com sucesso');
}

/**
 * INICIALIZAÇÃO DO SISTEMA
 */
async function initializeSystem() {
    try {
        logger.info('🧠 Inicializando Cérebro de Atendimento v3.1 CORRIGIDO...');
        
        // VALIDAÇÕES OBRIGATÓRIAS PRIMEIRO
        await validateSystemInitialization();
        
        // Conectar ao banco de dados
        await database.connect();
        logger.info('✅ Conexão com PostgreSQL estabelecida');
        
        // Conectar logger ao banco
        logger.setDatabase(database);
        logger.info('✅ Logger conectado ao banco de dados');
        
        // Executar migrações se necessário
        await database.migrate();
        logger.info('✅ Migrações do banco executadas');
        
        // Inicializar serviços
        await queueService.initialize();
        logger.info('✅ Sistema de filas inicializado');
        
        // Inicializar Evolution Service
        try {
            await evolutionService.initialize();
            logger.info('✅ Evolution Service inicializado');
        } catch (error) {
            logger.warn('⚠️ Evolution Service falhou na inicialização, continuando sem health check automático');
        }
        
        // Recuperar timeouts perdidos do banco
        await queueService.recoverTimeouts();
        logger.info('✅ Timeouts recuperados do banco');
        
        logger.info('🚀 Sistema inicializado com TODAS as correções aplicadas');
        
    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${error.message}`, error);
        
        console.error('\n🔥 SISTEMA NÃO PODE INICIAR 🔥');
        console.error('=====================================');
        console.error('Erro:', error.message);
        console.error('\n🔧 VERIFIQUE:');
        console.error('1. Arquivo .env existe e está configurado');
        console.error('2. PostgreSQL está rodando e acessível');
        console.error('3. Credenciais do banco estão corretas');
        console.error('4. URLs das APIs estão válidas');
        console.error('=====================================\n');
        
        process.exit(1);
    }
}

/**
 * TRATAMENTO DE ERRO E SHUTDOWN
 */
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    logger.info('Recebido SIGINT, finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('Sistema finalizado');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Recebido SIGTERM, finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('Sistema finalizado');
    process.exit(0);
});

/**
 * INICIAR SERVIDOR
 */
initializeSystem().then(() => {
    app.listen(PORT, () => {
        logger.info(`🧠 Cérebro de Atendimento v3.1 rodando na porta ${PORT}`);
        logger.info(`📊 Dashboard: http://localhost:${PORT}`);
        logger.info(`📥 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
        logger.info(`📥 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
        logger.info(`🧪 Testes N8N: http://localhost:${PORT}/test`);
        logger.info(`🔍 Diagnóstico: http://localhost:${PORT}/diagnostics`);
        logger.info(`🎯 N8N Target: ${CONFIG.N8N_WEBHOOK_URL}`);
        
        console.log('\n🧠 CÉREBRO DE ATENDIMENTO v3.1 - VERSÃO CORRIGIDA');
        console.log('==================================================');
        console.log(`📡 Webhooks configurados:`);
        console.log(`   Perfect Pay: http://localhost:${PORT}/webhook/perfect`);
        console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
        console.log(`🎯 N8N: ${CONFIG.N8N_WEBHOOK_URL}`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        console.log(`🧪 Testes: http://localhost:${PORT}/test`);
        console.log(`🔍 Diagnóstico: http://localhost:${PORT}/diagnostics`);
        console.log(`🔗 Check Payment: http://localhost:${PORT}/check-payment/:orderId`);
        console.log(`✅ Complete Flow: http://localhost:${PORT}/webhook/complete/:orderId`);
        console.log(`📞 Contatos: http://localhost:${PORT}/contacts/export/:instance`);
        console.log(`⏰ Horário: ${getBrazilTime()}`);
        console.log(`🗃️ PostgreSQL: ${database.isConnected() ? 'Conectado ✅' : 'Desconectado ❌'}`);
        console.log('\n🚀 CORREÇÕES APLICADAS v3.1:');
        console.log(`   ✅ Verificação final (25min) REMOVIDA completamente`);
        console.log(`   ✅ Verificação de pagamento antes das respostas`);
        console.log(`   ✅ Sistema de resposta única implementado`);
        console.log(`   ✅ Normalização de telefone consistente`);
        console.log(`   ✅ Logs de debug completos adicionados`);
        console.log(`   ✅ Validações de inicialização obrigatórias`);
        console.log(`   ✅ Endpoint de diagnóstico completo`);
        console.log(`   ⚠️ Endpoint Evolution será testado dinamicamente`);
        console.log('==================================================\n');
    });
}).catch(error => {
    logger.error(`❌ Falha ao iniciar servidor: ${error.message}`, error);
    process.exit(1);
});(`Erro ao obter instância para cliente ${clientNumber}: ${error.message}`);
        return 'GABY01';
    }
}

/**
 * WEBHOOK PERFECT PAY
 */
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const planCode = data.plan?.code;
        const product = getProductByPlanCode(planCode);
        
        const fullName = data.customer?.full_name || 'Cliente';
        const firstName = getFirstName(fullName);
        const phoneNumber = normalizePhoneNumber(formatPhoneNumber(
            data.customer?.phone_extension,
            data.customer?.phone_area_code,
            data.customer?.phone_number
        ));
        const amount = parseFloat(data.sale_amount) || 0;
        const pixUrl = data.billet_url || '';
        
        // Log completo do payload Perfect Pay
        logger.info(`Perfect Pay webhook recebido:`, {
            orderCode,
            status,
            product,
            phoneNumber,
            firstName,
            amount
        });

        logger.info(`Perfect Pay webhook: ${orderCode} | Status: ${status} | Cliente: ${firstName} | Produto: ${product} | Telefone: ${phoneNumber}`);
        
        if (status === 'approved') {
            await handleApprovedSale(orderCode, phoneNumber, firstName, fullName, product, amount, data);
        } else if (status === 'pending') {
            await handlePendingPix(orderCode, phoneNumber, firstName, fullName, product, amount, pixUrl, planCode, data);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Perfect processado',
            order_code: orderCode,
            product: product,
            status: status,
            normalized_phone: phoneNumber
        });
        
    } catch (error) {
        logger.error(`Erro no webhook Perfect Pay: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Processa venda aprovada
 */
async function handleApprovedSale(orderCode, phoneNumber, firstName, fullName, product, amount, originalData) {
    try {
        logger.info(`VENDA APROVADA: ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Telefone: ${phoneNumber}`);
        
        const instanceName = await getInstanceForClient(phoneNumber);
        await queueService.cancelAllTimeouts(orderCode);
        
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, client_name, created_at, updated_at)
            VALUES ($1, $2, $3, 'approved', 0, $4, $5, '', $6, NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'approved',
                current_step = 0,
                instance_name = $4,
                amount = $5,
                client_name = $6,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount, fullName]);
        
        const conversationId = conversation.rows[0].id;
        
        const eventData = {
            event_type: 'venda_aprovada',
            produto: product,
            instancia: instanceName,
            evento_origem: 'aprovada',
            cliente: {
                nome: firstName,
                telefone: phoneNumber,
                nome_completo: fullName
            },
            pedido: {
                codigo: orderCode,
                valor: amount
            },
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: conversationId
        };
        
        const success = await queueService.sendToN8N(eventData, 'venda_aprovada', conversationId);
        
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conversationId, 'system_event', `Venda aprovada: ${orderCode}`, success ? 'sent' : 'failed']
        );
        
        systemStats.totalEvents++;
        if (success) systemStats.successfulEvents++;
        else systemStats.failedEvents++;
        
        logger.info(`Venda aprovada processada: ${orderCode} | Status: ${success ? 'sucesso' : 'falha'}`);
        
    } catch (error) {
        logger.error(`Erro ao processar venda aprovada ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

/**
 * Processa PIX pendente
 */
async function handlePendingPix(orderCode, phoneNumber, firstName, fullName, product, amount, pixUrl, planCode, originalData) {
    try {
        logger.info(`PIX GERADO: ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Telefone: ${phoneNumber}`);
        
        const instanceName = await getInstanceForClient(phoneNumber);
        
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, client_name, created_at, updated_at)
            VALUES ($1, $2, $3, 'pix_pending', 0, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'pix_pending',
                current_step = 0,
                instance_name = $4,
                amount = $5,
                pix_url = $6,
                client_name = $7,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount, pixUrl, fullName]);
        
        const conversationId = conversation.rows[0].id;
        
        await queueService.addPixTimeout(orderCode, conversationId, CONFIG.PIX_TIMEOUT);
        
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conversationId, 'system_event', `PIX gerado: ${orderCode}`, 'sent']
        );
        
        systemStats.totalEvents++;
        systemStats.successfulEvents++;
        
        logger.info(`PIX pendente registrado: ${orderCode} | Timeout em 7 minutos`);
        
    } catch (error) {
        logger.error(`Erro ao processar PIX pendente ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

/**
 * WEBHOOK EVOLUTION API
 */
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        
        // Log completo do webhook Evolution
        logger.info(`Evolution webhook recebido:`, {
            instance: data.instance,
            apikey: data.apikey,
            event: data.event,
            dataKeys: data.data ? Object.keys(data.data) : []
        });
        
        const messageData = data.data;
        if (!messageData || !messageData.key) {
            logger.warn(`Estrutura inválida no webhook Evolution`, data);
            return res.status(200).json({ success: true, message: 'Estrutura inválida' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text || '';
        const instanceName = data.instance;
        
        // Normalizar telefone do Evolution
        const clientNumber = normalizePhoneNumber(remoteJid.replace('@s.whatsapp.net', ''));
        
        // Log específico das informações extraídas
        logger.info(`Evolution processando: RemoteJid: ${remoteJid} | FromMe: ${fromMe} | Cliente: ${clientNumber} | Conteúdo: "${messageContent.substring(0, 50)}..."`);
        
        if (fromMe) {
            await handleSystemMessage(clientNumber, messageContent, instanceName);
        } else {
            await handleClientResponse(clientNumber, messageContent, instanceName, messageData);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            from_me: fromMe,
            instance: instanceName
        });
        
    } catch (error) {
        logger.error(`Erro no webhook Evolution: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Processa mensagem enviada pelo sistema
 */
async function handleSystemMessage(clientNumber, messageContent, instanceName) {
    try {
        logger.info(`Mensagem do sistema registrada: ${clientNumber} | "${messageContent.substring(0, 50)}..."`);
        
        const conversation = await database.query(
            'SELECT id FROM conversations WHERE phone = $1 AND status IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
            [clientNumber, 'pix_pending', 'approved']
        );
        
        if (conversation.rows.length > 0) {
            const conversationId = conversation.rows[0].id;
            
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'sent', messageContent.substring(0, 500), 'delivered']
            );
            
            await database.query(
                'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
                [conversationId]
            );
            
            logger.info(`Mensagem do sistema registrada para ${clientNumber}`);
        } else {
            logger.warn(`Conversa não encontrada para registrar mensagem do sistema: ${clientNumber}`);
        }
        
    } catch (error) {
        logger.error(`Erro ao processar mensagem do sistema para ${clientNumber}: ${error.message}`, error);
    }
}

// FUNÇÃO CORRIGIDA - Verificar status de pagamento
async function checkPaymentStatus(orderCode) {
    try {
        logger.info(`Verificando status de pagamento: ${orderCode}`);
        
        const result = await database.query(
            'SELECT status FROM conversations WHERE order_code = $1 ORDER BY updated_at DESC LIMIT 1',
            [orderCode]
        );
        
        if (result.rows.length > 0) {
            const status = result.rows[0].status;
            const isPaid = status === 'approved' || status === 'completed';
            
            logger.info(`Status pagamento ${orderCode}: ${status} | Pago: ${isPaid}`);
            return isPaid;
        }
        
        logger.warn(`Pedido não encontrado para verificação de pagamento: ${orderCode}`);
        return false;
        
    } catch (error) {
        logger.error(`Erro ao verificar pagamento ${orderCode}: ${error.message}`);
        return false;
    }
}

// FUNÇÃO CORRIGIDA - Enviar evento de conversão
async function sendConversionEvent(conversation, messageContent, responseNumber) {
    try {
        const fullName = conversation.client_name || 'Cliente';
        const firstName = getFirstName(fullName);
        
        logger.info(`PIX pago detectado - enviando evento convertido: ${conversation.order_code} | Resposta ${responseNumber}`);
        
        const eventData = {
            event_type: 'convertido',
            produto: conversation.product,
            instancia: conversation.instance_name,
            evento_origem: 'pix_convertido',
            cliente: {
                telefone: conversation.phone,
                nome: firstName,
                nome_completo: fullName
            },
            conversao: {
                resposta_numero: responseNumber,
                conteudo_resposta: messageContent,
                valor_original: conversation.amount || 0,
                timestamp: new Date().toISOString(),
                brazil_time: getBrazilTime()
            },
            pedido: {
                codigo: conversation.order_code,
                valor: conversation.amount || 0,
                pix_url: conversation.pix_url || ''
            },
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: conversation.id
        };
        
        const success = await queueService.sendToN8N(eventData, 'convertido', conversation.id);
        
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conversation.id, 'system_event', `Convertido após resposta ${responseNumber}`, success ? 'sent' : 'failed']
        );
        
        logger.info(`Evento de conversão enviado: ${success ? 'sucesso' : 'falha'} | ${conversation.order_code}`);
        
        return success;
        
    } catch (error) {
        logger.error(`Erro ao enviar evento de conversão: ${error.message}`, error);
        return false;
    }
}

/**
 * FUNÇÃO CORRIGIDA - Processa resposta do cliente COM VERIFICAÇÃO DE PAGAMENTO E RESPOSTA ÚNICA
 */
async function handleClientResponse(clientNumber, messageContent, instanceName, messageData) {
    try {
        logger.info(`Resposta do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
        
        // Buscar conversa ativa normalizada
        const conversation = await database.query(`
            SELECT id, order_code, product, status, current_step, responses_count, instance_name, client_name, amount, pix_url
            FROM conversations 
            WHERE phone = $1 AND status IN ('pix_pending', 'approved') 
            ORDER BY created_at DESC LIMIT 1
        `, [clientNumber]);
        
        if (conversation.rows.length === 0) {
            logger.warn(`Cliente ${clientNumber} não encontrado nas conversas ativas - ignorando resposta`);
            return;
        }
        
        const conv = conversation.rows[0];
        
        logger.info(`Conversa encontrada: ${conv.order_code} | Status: ${conv.status} | Respostas: ${conv.responses_count}`);
        
        // VERIFICAR SE JÁ RESPONDEU À ÚLTIMA MENSAGEM SISTEMA (resposta única)
        const lastSystemMessage = await database.query(`
            SELECT id, created_at FROM messages 
            WHERE conversation_id = $1 AND type = 'sent' 
            ORDER BY created_at DESC LIMIT 1
        `, [conv.id]);
        
        const lastClientResponse = await database.query(`
            SELECT id, created_at FROM messages 
            WHERE conversation_id = $1 AND type = 'received' 
            ORDER BY created_at DESC LIMIT 1
        `, [conv.id]);
        
        // Se cliente já respondeu após última mensagem do sistema, ignorar
        if (lastSystemMessage.rows.length > 0 && lastClientResponse.rows.length > 0) {
            const systemTime = new Date(lastSystemMessage.rows[0].created_at).getTime();
            const clientTime = new Date(lastClientResponse.rows[0].created_at).getTime();
            
            if (clientTime > systemTime) {
                logger.info(`Resposta adicional ignorada - cliente ${clientNumber} já respondeu à última mensagem do sistema`);
                
                // Apenas registrar a mensagem adicional
                await database.query(
                    'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                    [conv.id, 'received', messageContent.substring(0, 500), 'ignored']
                );
                return;
            }
        }
        
        // PRIMEIRA RESPOSTA VÁLIDA - Incrementar contador
        const newResponseCount = conv.responses_count + 1;
        await database.query(
            'UPDATE conversations SET responses_count = $1, updated_at = NOW() WHERE id = $2',
            [newResponseCount, conv.id]
        );
        
        // Registrar mensagem recebida
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conv.id, 'received', messageContent.substring(0, 500), 'received']
        );
        
        logger.info(`Resposta válida ${newResponseCount} registrada para ${clientNumber}`);
        
        // VERIFICAÇÃO DE PAGAMENTO PARA PIX ANTES DE PROCESSAR RESPOSTA
        if (conv.status === 'pix_pending') {
            logger.info(`Verificando pagamento para PIX ${conv.order_code} antes de processar resposta ${newResponseCount}`);
            
            const isPaid = await checkPaymentStatus(conv.order_code);
            
            if (isPaid) {
                logger.info(`PIX ${conv.order_code} foi pago durante o fluxo - convertendo para CONVERTIDO`);
                
                // Cancelar timeouts do PIX
                await queueService.cancelAllTimeouts(conv.order_code);
                
                // Atualizar para status "convertido"
                await database.query(
                    'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2',
                    ['convertido', conv.id]
                );
                
                // Enviar evento de conversão para N8N
                await sendConversionEvent(conv, messageContent, newResponseCount);
                return;
            }
        }
        
        // PROCESSAR RESPOSTAS NORMALMENTE (sem verificação final)
        if (newResponseCount === 1) {
            await sendResponseToN8N(conv, messageContent, 1);
            
        } else if (newResponseCount === 2) {
            await sendResponseToN8N(conv, messageContent, 2);
            
        } else if (newResponseCount === 3) {
            await sendResponseToN8N(conv, messageContent, 3);
            
            // REMOVIDO: addFinalCheck - conforme correção 3
            
        } else {
            logger.info(`Resposta adicional além da 3ª ignorada do cliente ${clientNumber} | Resposta ${newResponseCount}`);
        }
        
    } catch (error) {
        logger.error(`Erro ao processar resposta do cliente ${clientNumber}: ${error.message}`, error);
    }
}

/**
 * Enviar resposta do cliente para N8N
 */
async function sendResponseToN8N(conversation, messageContent, responseNumber) {
    try {
        const fullName = conversation.client_name || 'Cliente';
        const firstName = getFirstName(fullName);
        
        logger.info(`Enviando resposta ${responseNumber} para N8N: ${conversation.order_code}`);
        
        const eventData = {
            event_type: `resposta_0${responseNumber}`,
            produto: conversation.product,
            instancia: conversation.instance_name,
            evento_origem: conversation.status === 'approved' ? 'aprovada' : 'pix',
            cliente: {
                telefone: conversation.phone,
                nome: firstName,
                nome_completo: fullName
            },
            resposta: {
                numero: responseNumber,
                conteudo: messageContent,
                timestamp: new Date().toISOString(),
                brazil_time: getBrazilTime()
            },
            pedido: {
                codigo: conversation.order_code,
                valor: conversation.amount || 0,
                pix_url: conversation.pix_url || ''
            },
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: conversation.id
        };
        
        const success = await queueService.sendToN8N(eventData, `resposta_0${responseNumber}`, conversation.id);
        
        logger.info(`Resposta ${responseNumber} enviada para N8N: ${success ? 'sucesso' : 'falha'} | ${conversation.order_code}`);
        
        return success;
        
    } catch (error) {
        logger.error(`Erro ao enviar resposta ${responseNumber} para N8N: ${error.message}`, error);
        return false;
    }
}

/**
 * NOVOS ENDPOINTS PARA N8N
 */
app.get('/check-payment/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        logger.info(`Check payment solicitado: ${orderId}`);
        
        const conversation = await database.query(
            'SELECT status FROM conversations WHERE order_code = $1 ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        
        if (conversation.rows.length === 0) {
            logger.warn(`Pedido não encontrado para check payment: ${orderId}`);
            return res.json({ status: 'not_found' });
        }
        
        const status = conversation.rows[0].status;
        const isPaid = status === 'approved' || status === 'completed';
        
        logger.info(`Check payment ${orderId}: Status ${status} | Pago: ${isPaid}`);
        
        res.json({ 
            status: isPaid ? 'paid' : 'pending',
            order_id: orderId,
            conversation_status: status
        });
        
    } catch (error) {
        logger.error(`Erro ao verificar pagamento ${req.params.orderId}: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/complete/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        logger.info(`Marcando fluxo como completo: ${orderId}`);
        
        await database.query(
            'UPDATE conversations SET status = $1, updated_at = NOW() WHERE order_code = $2',
            ['completed', orderId]
        );
        
        await queueService.cancelAllTimeouts(orderId);
        
        logger.info(`Fluxo marcado como completo: ${orderId}`);
        
        res.json({ 
            success: true, 
            message: 'Fluxo marcado como completo',
            order_id: orderId
        });
        
    } catch (error) {
        logger.error(`Erro ao marcar fluxo completo ${req.params.orderId}: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * ENDPOINTS ADMINISTRATIVOS
 */

// Dashboard principal
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

// Status do sistema
app.get('/status', async (req, res) => {
    try {
        const [
            pendingPix,
            activeConversations,
            totalLeads,
            recentMessages,
            conversations
        ] = await Promise.all([
            database.query("SELECT COUNT(*) FROM conversations WHERE status = 'pix_pending'"),
            database.query("SELECT COUNT(*) FROM conversations WHERE status IN ('pix_pending', 'approved')"),
            database.query("SELECT COUNT(*) FROM leads"),
            database.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 50"),
            database.query(`
                SELECT c.*, l.instance_name 
                FROM conversations c
                LEFT JOIN leads l ON c.phone = l.phone
                WHERE c.status IN ('pix_pending', 'approved')
                ORDER BY c.created_at DESC
            `)
        ]);
        
        res.json({
            system_status: 'online',
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            uptime: Math.floor(process.uptime()),
            database: database.isConnected() ? 'connected' : 'disconnected',
            stats: {
                pending_pix: parseInt(pendingPix.rows[0].count),
                active_conversations: parseInt(activeConversations.rows[0].count),
                total_leads: parseInt(totalLeads.rows[0].count),
                total_events: systemStats.totalEvents,
                successful_events: systemStats.successfulEvents,
                failed_events: systemStats.failedEvents,
                success_rate: systemStats.totalEvents > 0 
                    ? ((systemStats.successfulEvents / systemStats.totalEvents) * 100).toFixed(2) + '%'
                    : '0%'
            },
            config: {
                n8n_webhook_url: CONFIG.N8N_WEBHOOK_URL,
                evolution_api_url: CONFIG.EVOLUTION_API_URL,
                pix_timeout: CONFIG.PIX_TIMEOUT,
                instances_active: INSTANCES.filter(i => i.active).length
            },
            recent_messages: recentMessages.rows,
            conversations: conversations.rows
        });
        
    } catch (error) {
        logger.error(`Erro ao obter status do sistema: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT DE EVENTOS
app.get('/events', async (req, res) => {
    try {
        const { limit = 100, type, status } = req.query;
        
        let query = `
            SELECT m.*, c.order_code, c.product, c.client_name, c.instance_name
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE m.type IN ('system_event', 'n8n_sent')
        `;
        
        const params = [];
        
        if (type) {
            query += ' AND m.content LIKE  + (params.length + 1);
            params.push(`%${type}%`);
        }
        
        if (status) {
            query += ' AND m.status =  + (params.length + 1);
            params.push(status);
        }
        
        query += ' ORDER BY m.created_at DESC LIMIT  + (params.length + 1);
        params.push(limit);
        
        const events = await database.query(query, params);
        
        res.json({
            events: events.rows.map(event => ({
                id: event.id,
                type: event.content.split(':')[0] || 'system_event',
                date: getBrazilTime('DD/MM/YYYY', event.created_at),
                time: getBrazilTime('HH:mm:ss', event.created_at),
                clientName: event.client_name || 'Cliente',
                clientPhone: 'N/A',
                orderCode: event.order_code || 'N/A',
                product: event.product || 'N/A',
                status: event.status === 'sent' || event.status === 'delivered' ? 'success' : 'failed',
                instance: event.instance_name || 'N/A'
            }))
        });
        
    } catch (error) {
        logger.error(`Erro ao obter eventos: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// ENDPOINT DE LOGS
app.get('/logs', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const logs = await logger.getRecentLogs(limit);
        res.json({ logs });
    } catch (error) {
        logger.error(`Erro ao obter logs: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// STATUS DAS INSTÂNCIAS - ENDPOINT CORRIGIDO (problema 2)
app.get('/instances/status', async (req, res) => {
    try {
        const instancesStatus = [];
        
        // Lista de endpoints possíveis para testar
        const possibleEndpoints = [
            '/instance/connectionState',
            '/instance/connect',
            '/instance/fetchInstances',
            '/instance/status'
        ];
        
        for (const instance of INSTANCES) {
            let isConnected = false;
            let workingEndpoint = null;
            
            // Testar cada endpoint possível até encontrar um que funciona
            for (const endpoint of possibleEndpoints) {
                try {
                    logger.debug(`Testando endpoint ${endpoint}/${instance.name}`);
                    
                    const response = await axios.get(`${CONFIG.EVOLUTION_API_URL}${endpoint}/${instance.name}`, {
                        timeout: 8000,
                        headers: { 'apikey': instance.id }
                    });
                    
                    // Verificar diferentes formatos de resposta
                    if (response.data?.instance?.state === 'open' || 
                        response.data?.state === 'open' || 
                        response.data?.status === 'open' || 
                        response.data?.connected === true) {
                        
                        isConnected = true;
                        workingEndpoint = endpoint;
                        logger.info(`Instância ${instance.name} online via ${endpoint}`);
                        break;
                    }
                    
                } catch (error) {
                    logger.debug(`Endpoint ${endpoint} falhou para ${instance.name}: ${error.message}`);
                    continue;
                }
            }
            
            if (!isConnected) {
                logger.warn(`Instância ${instance.name} offline ou inacessível em todos os endpoints`);
            }
            
            instancesStatus.push({
                name: instance.name,
                id: instance.id,
                status: isConnected ? 'online' : 'offline',
                active: isConnected,
                workingEndpoint: workingEndpoint,
                lastCheck: new Date().toISOString(),
                lastCheckBrazil: getBrazilTime()
            });
        }

        const onlineCount = instancesStatus.filter(i => i.status === 'online').length;
        
        logger.info(`Verificação de instâncias concluída: ${onlineCount}/${INSTANCES.length} online`);
        
        res.json({
            instances: instancesStatus,
            summary: {
                total: INSTANCES.length,
                online: onlineCount,
                offline: INSTANCES.length - onlineCount
            }
        });

    } catch (error) {
        logger.error(`Erro ao verificar instâncias: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// HEALTH CHECK MANUAL
app.post('/instances/health-check', async (req, res) => {
    try {
        const response = await axios.get(`${req.protocol}://${req.get('host')}/instances/status`);
        res.json({
            success: true,
            online: response.data.summary.online,
            total: response.data.summary.total
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ESTATÍSTICAS DA FILA
app.get('/queue/stats', async (req, res) => {
    try {
        const stats = await queueService.getQueueStats();
        res.json(stats);
    } catch (error) {
        logger.error(`Erro ao obter stats da fila: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// LIMPEZA MANUAL
app.post('/cleanup', async (req, res) => {
    try {
        await database.cleanup();
        await logger.cleanupOldLogs();
        res.json({ success: true, message: 'Limpeza executada com sucesso' });
    } catch (error) {
        logger.error(`Erro na limpeza: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check simples
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        database: database.isConnected() ? 'connected' : 'disconnected',
        config: CONFIG
    });
});

/**
 * NOVOS ENDPOINTS PARA EXPORTAÇÃO DE CONTATOS POR INSTÂNCIA
 */
app.get('/contacts/export/:instance?', async (req, res) => {
    try {
        const { instance } = req.params;
        
        let query = `
            SELECT l.phone, l.instance_name, l.created_at, c.client_name
            FROM leads l
            LEFT JOIN conversations c ON l.phone = c.phone
        `;
        
        let params = [];
        let filename = 'todos_contatos';
        
        if (instance && instance !== 'all') {
            query += ' WHERE l.instance_name = $1';
            params.push(instance.toUpperCase());
            filename = `contatos_${instance.toLowerCase()}`;
        }
        
        query += ' ORDER BY l.created_at DESC';
        
        const leads = await database.query(query, params);
        
        // Formato Google Contacts
        let csv = 'Name,Given Name,Phone 1 - Value,Notes\n';
        
        for (const lead of leads.rows) {
            const date = new Date(lead.created_at).toLocaleDateString('pt-BR', { 
                timeZone: 'America/Sao_Paulo',
                day: '2-digit',
                month: '2-digit'
            });
            
            const name = `${date} - Cliente ${lead.phone.slice(-4)}`;
            const notes = `Instância: ${lead.instance_name}`;
            
            csv += `"${name}","${name}","${lead.phone}","${notes}"\n`;
        }
        
        const today = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}_${today}.csv"`);
        res.send(csv);
        
        logger.info(`Contatos exportados: ${instance || 'todas instâncias'} - ${leads.rows.length} contatos`);
        
    } catch (error) {
        logger.error
