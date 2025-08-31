/**
 * CÉREBRO DE ATENDIMENTO v3.0 - Sistema Principal
 * Sistema robusto de atendimento automatizado via WhatsApp
 * Integra Perfect Pay, Evolution API, N8N com PostgreSQL
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const moment = require('moment-timezone');

// Importar módulos do sistema
const database = require('./database/config');
const evolutionService = require('./services/evolution');
const queueService = require('./services/queue');
const logger = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares de segurança
app.use(helmet({
    contentSecurityPolicy: false // Para permitir dashboard HTML inline
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configurações globais
const CONFIG = {
    PIX_TIMEOUT: parseInt(process.env.PIX_TIMEOUT) || 420000, // 7 minutos
    FINAL_MESSAGE_DELAY: parseInt(process.env.FINAL_MESSAGE_DELAY) || 1500000, // 25 minutos
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

// Função para formatar telefone
function formatPhoneNumber(extension, areaCode, number) {
    const ext = extension || '55';
    const area = areaCode || '';
    const num = number || '';
    
    // Normalização: remove 9 extra se necessário
    let fullNumber = ext + area + num;
    if (fullNumber.length === 14 && fullNumber.substring(4, 5) === '9') {
        // Remove 9 extra: 5511987654321 -> 5511987654321
        fullNumber = fullNumber.substring(0, 4) + fullNumber.substring(5);
    }
    
    return fullNumber;
}

// Função para obter instância sticky por lead
async function getInstanceForClient(clientNumber) {
    try {
        logger.info(`Verificando instância para cliente: ${clientNumber}`);
        
        // Busca no banco se cliente já tem instância atribuída
        const existingLead = await database.query(
            'SELECT instance_name FROM leads WHERE phone = $1',
            [clientNumber]
        );
        
        if (existingLead.rows.length > 0) {
            const instanceName = existingLead.rows[0].instance_name;
            logger.info(`Cliente ${clientNumber} já atribuído à instância ${instanceName}`);
            return instanceName;
        }
        
        // Busca instância com menor carga (menos leads ativos)
        const instanceLoad = await database.query(`
            SELECT instance_name, COUNT(*) as lead_count 
            FROM leads 
            GROUP BY instance_name
            ORDER BY lead_count ASC
        `);
        
        let selectedInstance;
        
        if (instanceLoad.rows.length === 0) {
            // Primeiro cliente - usar GABY01
            selectedInstance = 'GABY01';
        } else {
            // Buscar instância com menor carga
            const currentLoads = {};
            instanceLoad.rows.forEach(row => {
                currentLoads[row.instance_name] = parseInt(row.lead_count);
            });
            
            // Verificar qual instância tem menor carga ou não aparece na lista
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
        
        // Salvar atribuição no banco
        await database.query(
            'INSERT INTO leads (phone, instance_name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET instance_name = $2, updated_at = NOW()',
            [clientNumber, selectedInstance]
        );
        
        logger.info(`Cliente ${clientNumber} atribuído à instância ${selectedInstance} (menor carga)`);
        return selectedInstance;
        
    } catch (error) {
        logger.error(`Erro ao obter instância para cliente ${clientNumber}: ${error.message}`);
        // Fallback para GABY01
        return 'GABY01';
    }
}

/**
 * WEBHOOK PERFECT PAY
 * Recebe eventos de pagamento (pending/approved)
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
        const phoneNumber = formatPhoneNumber(
            data.customer?.phone_extension,
            data.customer?.phone_area_code,
            data.customer?.phone_number
        );
        const amount = parseFloat(data.sale_amount) || 0;
        const pixUrl = data.billet_url || '';
        
        logger.info(`Perfect Pay webhook: ${orderCode} | Status: ${status} | Cliente: ${firstName} | Produto: ${product}`);
        
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
            status: status
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
        logger.info(`VENDA APROVADA: ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
        
        // Obter instância sticky
        const instanceName = await getInstanceForClient(phoneNumber);
        
        // Verificar se existe PIX pendente e cancelar
        await queueService.cancelPendingPix(orderCode);
        
        // Criar/atualizar conversa no banco
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, created_at, updated_at)
            VALUES ($1, $2, $3, 'approved', 0, $4, $5, '', NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'approved',
                current_step = 0,
                instance_name = $4,
                amount = $5,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount]);
        
        const conversationId = conversation.rows[0].id;
        
        // Enviar para N8N
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
        
        // Registrar no banco
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
        logger.info(`PIX GERADO: ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
        
        // Obter instância sticky
        const instanceName = await getInstanceForClient(phoneNumber);
        
        // Criar conversa no banco
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, created_at, updated_at)
            VALUES ($1, $2, $3, 'pix_pending', 0, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'pix_pending',
                current_step = 0,
                instance_name = $4,
                amount = $5,
                pix_url = $6,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount, pixUrl]);
        
        const conversationId = conversation.rows[0].id;
        
        // Adicionar à fila de timeout (7 minutos)
        await queueService.addPixTimeout(orderCode, conversationId, CONFIG.PIX_TIMEOUT);
        
        // Registrar evento
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
 * Recebe mensagens do WhatsApp
 */
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        
        logger.info(`Evolution webhook recebido`, { 
            instance: data.instance,
            apikey: data.apikey,
            event: data.event
        });
        
        // Verificar estrutura dos dados
        const messageData = data.data;
        if (!messageData || !messageData.key) {
            logger.warn(`Estrutura inválida no webhook Evolution`, data);
            return res.status(200).json({ success: true, message: 'Estrutura inválida' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text || '';
        const instanceName = data.instance;
        
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        if (fromMe) {
            // Mensagem enviada pelo sistema - apenas registrar
            await handleSystemMessage(clientNumber, messageContent, instanceName);
        } else {
            // Resposta do cliente - processar
            await handleClientResponse(clientNumber, messageContent, instanceName, messageData);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            from_me: fromMe
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
        // Buscar conversa ativa
        const conversation = await database.query(
            'SELECT id FROM conversations WHERE phone = $1 AND status IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
            [clientNumber, 'pix_pending', 'approved']
        );
        
        if (conversation.rows.length > 0) {
            const conversationId = conversation.rows[0].id;
            
            // Registrar mensagem enviada
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'sent', messageContent.substring(0, 500), 'delivered']
            );
            
            // Atualizar timestamp da conversa
            await database.query(
                'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
                [conversationId]
            );
            
            logger.info(`Mensagem do sistema registrada para ${clientNumber}`);
        }
        
    } catch (error) {
        logger.error(`Erro ao processar mensagem do sistema para ${clientNumber}: ${error.message}`, error);
    }
}

/**
 * Processa resposta do cliente
 */
async function handleClientResponse(clientNumber, messageContent, instanceName, messageData) {
    try {
        logger.info(`Resposta do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
        
        // Buscar conversa ativa
        const conversation = await database.query(`
            SELECT id, order_code, product, status, current_step, responses_count, instance_name
            FROM conversations 
            WHERE phone = $1 AND status IN ('pix_pending', 'approved') 
            ORDER BY created_at DESC LIMIT 1
        `, [clientNumber]);
        
        if (conversation.rows.length === 0) {
            logger.warn(`Cliente ${clientNumber} não encontrado nas conversas ativas - ignorando resposta`);
            return;
        }
        
        const conv = conversation.rows[0];
        
        // Incrementar contador de respostas
        const newResponseCount = conv.responses_count + 1;
        await database.query(
            'UPDATE conversations SET responses_count = $1, updated_at = NOW() WHERE id = $2',
            [newResponseCount, conv.id]
        );
        
        // Registrar mensagem recebida
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conv.id, 'received', messageContent, 'received']
        );
        
        // Processar baseado no número da resposta
        if (newResponseCount === 1) {
            // Primeira resposta - enviar resposta_01 para N8N
            await sendResponseToN8N(conv, messageContent, 1);
            
        } else if (newResponseCount === 2) {
            // Segunda resposta - enviar resposta_02 para N8N
            await sendResponseToN8N(conv, messageContent, 2);
            
        } else if (newResponseCount === 3) {
            // Terceira resposta - enviar resposta_03 para N8N e agendar verificação final
            await sendResponseToN8N(conv, messageContent, 3);
            
            // Agendar verificação de pagamento em 25 minutos
            await queueService.addFinalCheck(conv.order_code, conv.id, CONFIG.FINAL_MESSAGE_DELAY);
            
        } else {
            logger.info(`Resposta adicional ignorada do cliente ${clientNumber} (já tem ${newResponseCount} respostas)`);
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
        
        const eventData = {
            event_type: `resposta_0${responseNumber}`,
            produto: conversation.product,
            instancia: conversation.instance_name,
            evento_origem: conversation.status === 'approved' ? 'aprovada' : 'pix',
            cliente: {
                telefone: conversation.phone,
                nome: firstName
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
                billet_url: conversation.pix_url || ''
            },
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: conversation.id
        };
        
        const success = await queueService.sendToN8N(eventData, `resposta_0${responseNumber}`, conversation.id);
        
        logger.info(`Resposta ${responseNumber} enviada para N8N: ${success ? 'sucesso' : 'falha'}`);
        
        return success;
        
    } catch (error) {
        logger.error(`Erro ao enviar resposta ${responseNumber} para N8N: ${error.message}`, error);
        return false;
    }
}

/**
 * NOVOS ENDPOINTS PARA N8N
 */

// Endpoint para verificar pagamento
app.get('/check-payment/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        const conversation = await database.query(
            'SELECT status FROM conversations WHERE order_code = $1 ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        
        if (conversation.rows.length === 0) {
            return res.json({ status: 'not_found' });
        }
        
        const status = conversation.rows[0].status;
        const isPaid = status === 'approved' || status === 'completed';
        
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

// Endpoint para marcar fluxo como completo
app.post('/webhook/complete/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        await database.query(
            'UPDATE conversations SET status = $1, updated_at = NOW() WHERE order_code = $2',
            ['completed', orderId]
        );
        
        // Cancelar timeouts pendentes
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
            recentMessages
        ] = await Promise.all([
            database.query("SELECT COUNT(*) FROM conversations WHERE status = 'pix_pending'"),
            database.query("SELECT COUNT(*) FROM conversations WHERE status IN ('pix_pending', 'approved')"),
            database.query("SELECT COUNT(*) FROM leads"),
            database.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 50")
        ]);
        
        res.json({
            system_status: 'online',
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            uptime: Math.floor(process.uptime()),
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
                pix_timeout: CONFIG.PIX_TIMEOUT,
                final_message_delay: CONFIG.FINAL_MESSAGE_DELAY,
                instances_active: INSTANCES.filter(i => i.active).length
            },
            recent_messages: recentMessages.rows
        });
        
    } catch (error) {
        logger.error(`Erro ao obter status do sistema: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        database: database.isConnected() ? 'connected' : 'disconnected',
        config: CONFIG
    });
});

// Exportar contatos (CSV)
app.get('/contacts/export', async (req, res) => {
    try {
        const leads = await database.query(`
            SELECT l.phone, l.instance_name, l.created_at,
                   c.order_code, c.product, c.status, c.amount
            FROM leads l
            LEFT JOIN conversations c ON l.phone = c.phone
            ORDER BY l.created_at DESC
        `);
        
        let csv = 'Telefone,Instancia,Nome_Cliente,Produto,Status,Valor,Data_Cadastro\n';
        
        for (const lead of leads.rows) {
            const date = getBrazilTime('DD/MM - HH:mm');
            const clientName = `${date} - Cliente ${lead.phone.slice(-4)}`;
            
            csv += `${lead.phone},${lead.instance_name},${clientName},${lead.product || 'N/A'},${lead.status || 'N/A'},${lead.amount || 0},${getBrazilTime('DD/MM/YYYY', lead.created_at)}\n`;
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="contatos_' + getBrazilTime('YYYY-MM-DD') + '.csv"');
        res.send(csv);
        
    } catch (error) {
        logger.error(`Erro ao exportar contatos: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * INICIALIZAÇÃO DO SISTEMA
 */
async function initializeSystem() {
    try {
        logger.info('Inicializando Cérebro de Atendimento v3.0...');
        
        // Conectar ao banco de dados
        await database.connect();
        logger.info('Conexão com PostgreSQL estabelecida');
        
        // Executar migrações se necessário
        await database.migrate();
        logger.info('Migrações do banco executadas');
        
        // Inicializar serviços
        await queueService.initialize();
        logger.info('Sistema de filas inicializado');
        
        // Recuperar timeouts perdidos do banco
        await queueService.recoverTimeouts();
        logger.info('Timeouts recuperados do banco');
        
        logger.info('Sistema inicializado com sucesso');
        
    } catch (error) {
        logger.error(`Erro na inicialização: ${error.message}`, error);
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
        logger.info(`Cérebro de Atendimento v3.0 rodando na porta ${PORT}`);
        logger.info(`Dashboard: http://localhost:${PORT}`);
        logger.info(`Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
        logger.info(`Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
        logger.info(`N8N Target: ${CONFIG.N8N_WEBHOOK_URL}`);
        
        console.log('\n🧠 CÉREBRO DE ATENDIMENTO v3.0 ATIVO');
        console.log('=====================================');
        console.log(`📡 Webhooks configurados:`);
        console.log(`   Perfect Pay: http://localhost:${PORT}/webhook/perfect`);
        console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
        console.log(`🎯 N8N: ${CONFIG.N8N_WEBHOOK_URL}`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        console.log(`🔗 Check Payment: http://localhost:${PORT}/check-payment/:orderId`);
        console.log(`✅ Complete Flow: http://localhost:${PORT}/webhook/complete/:orderId`);
        console.log(`⏰ Horário: ${getBrazilTime()}`);
        console.log(`🗃️ PostgreSQL: ${database.isConnected() ? 'Conectado' : 'Desconectado'}`);
        console.log('=====================================\n');
    });
}).catch(error => {
    logger.error(`Falha ao iniciar servidor: ${error.message}`, error);
    process.exit(1);
});
