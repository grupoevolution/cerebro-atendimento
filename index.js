/**
 * CÉREBRO DE ATENDIMENTO v3.3 - VERSÃO CORRIGIDA E FUNCIONAL
 * Sistema robusto de atendimento automatizado via WhatsApp
 * 
 * CORREÇÕES APLICADAS:
 * ✅ Webhook N8N confirm adicionado
 * ✅ Sistema de respostas simplificado e funcional
 * ✅ Verificação de duplicatas otimizada
 * ✅ Logs de debug completos
 * ✅ Código limpo e organizado
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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configurações globais
const CONFIG = {
    PIX_TIMEOUT: parseInt(process.env.PIX_TIMEOUT) || 420000, // 7 minutos
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/cerebro-atendimento',
    EVOLUTION_API_URL: process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun',
    MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3
};

// Log da configuração na inicialização para debug
logger.info(`🎯 N8N Webhook URL configurada: ${CONFIG.N8N_WEBHOOK_URL}`);

// Mapeamento de produtos
const PRODUCT_MAPPING = {
    'PPLQQM9AP': 'FAB',
    'PPLQQMAGU': 'FAB', 
    'PPLQQMADF': 'FAB',
    'PPLQQN0FT': 'NAT',
    'PPLQQMSFH': 'CS',
    'PPLQQMSFI': 'CS'
};

// Instâncias Evolution API
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

// Estatísticas do sistema
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

/**
 * FUNÇÕES UTILITÁRIAS
 */

// Normalizar telefone (versão unificada)
function normalizePhoneNumber(phone) {
    if (!phone) {
        logger.debug('Telefone vazio recebido para normalização');
        return phone;
    }
    
    logger.debug(`Normalizando telefone: "${phone}"`);
    
    let cleanPhone = String(phone).trim();
    cleanPhone = cleanPhone.replace(/\D/g, '');
    
    // Padronizar para formato brasileiro: 5511999999999 (13 dígitos)
    if (cleanPhone.length === 14 && cleanPhone.substring(0, 2) === '55') {
        const areaCode = cleanPhone.substring(2, 4);
        const restNumber = cleanPhone.substring(4);
        
        if (restNumber.charAt(0) === '9' && restNumber.charAt(1) !== '9' && restNumber.length === 10) {
            cleanPhone = '55' + areaCode + restNumber.substring(1);
        }
    } else if (cleanPhone.length === 11) {
        cleanPhone = '55' + cleanPhone;
    } else if (cleanPhone.length === 12 && !cleanPhone.startsWith('55')) {
        cleanPhone = '55' + cleanPhone.substring(1);
    }
    
    logger.debug(`Telefone normalizado: "${cleanPhone}"`);
    return cleanPhone;
}

// Formatar telefone do Perfect Pay
function formatPhoneFromPerfectPay(extension, areaCode, number) {
    const ext = extension || '55';
    const area = areaCode || '';
    const num = number || '';
    const fullNumber = ext + area + num;
    
    logger.debug(`Formatando Perfect Pay: ext="${ext}", area="${area}", num="${num}" -> "${fullNumber}"`);
    return normalizePhoneNumber(fullNumber);
}

// Obter horário de Brasília
function getBrazilTime(format = 'YYYY-MM-DD HH:mm:ss') {
    return moment().tz('America/Sao_Paulo').format(format);
}

// Extrair produto do código do plano
function getProductByPlanCode(planCode) {
    return PRODUCT_MAPPING[planCode] || 'UNKNOWN';
}

// Extrair primeiro nome
function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0].trim() : 'Cliente';
}

/**
 * BALANCEAMENTO DE CARGA
 */
async function getInstanceForClient(clientNumber) {
    try {
        const normalizedPhone = normalizePhoneNumber(clientNumber);
        logger.info(`🔍 Verificando instância para cliente: ${normalizedPhone}`);
        
        // Verificar se já existe atribuição
        const existingLead = await database.query(
            'SELECT instance_name FROM leads WHERE phone = $1',
            [normalizedPhone]
        );
        
        if (existingLead.rows.length > 0) {
            const instanceName = existingLead.rows[0].instance_name;
            logger.info(`👤 Cliente ${normalizedPhone} já atribuído à instância ${instanceName}`);
            return instanceName;
        }
        
        // Buscar carga atual de cada instância (últimos 30 dias)
        const instanceLoad = await database.query(`
            SELECT instance_name, COUNT(*) as lead_count 
            FROM leads 
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY instance_name
            ORDER BY lead_count ASC
        `);
        
        let selectedInstance = 'GABY01'; // fallback
        
        if (instanceLoad.rows.length === 0) {
            selectedInstance = INSTANCES[0].name;
            logger.info(`📍 Primeira atribuição - usando ${selectedInstance}`);
        } else {
            // Criar mapa de cargas atuais
            const currentLoads = {};
            instanceLoad.rows.forEach(row => {
                currentLoads[row.instance_name] = parseInt(row.lead_count);
            });
            
            // Encontrar instância ativa com menor carga
            let minLoad = Infinity;
            for (const instance of INSTANCES) {
                if (!instance.active) continue;
                
                const load = currentLoads[instance.name] || 0;
                if (load < minLoad) {
                    minLoad = load;
                    selectedInstance = instance.name;
                }
            }
            
            logger.info(`⚖️ Balanceamento: ${selectedInstance} selecionada com ${minLoad} leads`);
        }
        
        // Inserir nova atribuição
        await database.query(
            'INSERT INTO leads (phone, instance_name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET instance_name = $2, updated_at = NOW()',
            [normalizedPhone, selectedInstance]
        );
        
        logger.info(`✅ Cliente ${normalizedPhone} atribuído à instância ${selectedInstance}`);
        return selectedInstance;
        
    } catch (error) {
        logger.error(`Erro ao obter instância para cliente ${clientNumber}: ${error.message}`, error);
        return 'GABY01'; // fallback seguro
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
        const phoneNumber = formatPhoneFromPerfectPay(
            data.customer?.phone_extension,
            data.customer?.phone_area_code,
            data.customer?.phone_number
        );
        const amount = parseFloat(data.sale_amount) || 0;
        const pixUrl = data.billet_url || '';
        
        logger.info(`📥 PERFECT PAY WEBHOOK: ${orderCode} | ${status} | ${product} | ${phoneNumber}`);

        if (status === 'approved') {
            await handleApprovedSale(orderCode, phoneNumber, firstName, fullName, product, amount, data);
        } else if (status === 'pending') {
            await handlePendingPix(orderCode, phoneNumber, firstName, fullName, product, amount, pixUrl, planCode, data);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Perfect processado',
            order_code: orderCode,
            status: status,
            normalized_phone: phoneNumber
        });
        
    } catch (error) {
        logger.error(`❌ Erro no webhook Perfect Pay: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PROCESSAR VENDA APROVADA
 */
async function handleApprovedSale(orderCode, phoneNumber, firstName, fullName, product, amount, originalData) {
    try {
        logger.info(`💰 VENDA APROVADA: ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
        
        const instanceName = await getInstanceForClient(phoneNumber);
        
        // Cancelar timeouts pendentes
        await queueService.cancelAllTimeouts(orderCode);
        
        // Inserir/atualizar conversa
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, client_name, created_at, updated_at)
            VALUES ($1, $2, $3, 'approved', 0, $4, $5, '', $6, NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'approved',
                instance_name = $4,
                amount = $5,
                client_name = $6,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount, fullName]);
        
        const conversationId = conversation.rows[0].id;
        
        // Preparar dados para N8N
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
        
        // Enviar para N8N
        const success = await queueService.sendToN8N(eventData, 'venda_aprovada', conversationId);
        
        // Registrar evento
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conversationId, 'system_event', `Venda aprovada: ${orderCode}`, success ? 'sent' : 'failed']
        );
        
        systemStats.totalEvents++;
        if (success) {
            systemStats.successfulEvents++;
        } else {
            systemStats.failedEvents++;
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar venda aprovada ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

/**
 * PROCESSAR PIX PENDENTE
 */
async function handlePendingPix(orderCode, phoneNumber, firstName, fullName, product, amount, pixUrl, planCode, originalData) {
    try {
        logger.info(`⏰ PIX GERADO: ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
        
        const instanceName = await getInstanceForClient(phoneNumber);
        
        // Inserir/atualizar conversa
        const conversation = await database.query(`
            INSERT INTO conversations 
            (phone, order_code, product, status, current_step, instance_name, amount, pix_url, client_name, created_at, updated_at)
            VALUES ($1, $2, $3, 'pix_pending', 0, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (order_code) 
            DO UPDATE SET 
                status = 'pix_pending',
                instance_name = $4,
                amount = $5,
                pix_url = $6,
                client_name = $7,
                updated_at = NOW()
            RETURNING id
        `, [phoneNumber, orderCode, product, instanceName, amount, pixUrl, fullName]);
        
        const conversationId = conversation.rows[0].id;
        
        // Agendar timeout de 7 minutos
        await queueService.addPixTimeout(orderCode, conversationId, CONFIG.PIX_TIMEOUT);
        
        // Registrar evento
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [conversationId, 'system_event', `PIX gerado: ${orderCode}`, 'sent']
        );
        
        systemStats.totalEvents++;
        systemStats.successfulEvents++;
        
        logger.info(`✅ PIX pendente registrado: ${orderCode}`);
        
    } catch (error) {
        logger.error(`❌ Erro ao processar PIX pendente ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

/**
 * WEBHOOK EVOLUTION API
 */
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            logger.warn(`⚠️ Estrutura inválida no webhook Evolution`);
            return res.status(200).json({ success: true, message: 'Estrutura inválida' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || 
                              messageData.message?.extendedTextMessage?.text || 
                              messageData.message?.imageMessage?.caption || 
                              '';
        const instanceName = data.instance;
        
        const clientNumber = normalizePhoneNumber(remoteJid.replace('@s.whatsapp.net', ''));
        
        logger.info(`📱 Evolution: ${fromMe ? 'Sistema' : 'Cliente'} | ${clientNumber} | ${instanceName}`);
        
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
        logger.error(`❌ Erro no webhook Evolution: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PROCESSAR MENSAGEM DO SISTEMA
 */
async function handleSystemMessage(clientNumber, messageContent, instanceName) {
    try {
        logger.info(`📤 Mensagem do sistema: ${clientNumber}`);
        
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
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar mensagem do sistema: ${error.message}`, error);
    }
}

/**
 * VERIFICAR STATUS DE PAGAMENTO
 */
async function checkPaymentStatus(orderCode) {
    try {
        const result = await database.query(
            'SELECT status FROM conversations WHERE order_code = $1 ORDER BY updated_at DESC LIMIT 1',
            [orderCode]
        );
        
        if (result.rows.length > 0) {
            const status = result.rows[0].status;
            const isPaid = status === 'approved' || status === 'completed';
            logger.debug(`💳 Status pagamento ${orderCode}: ${status} | Pago: ${isPaid}`);
            return isPaid;
        }
        
        return false;
        
    } catch (error) {
        logger.error(`❌ Erro ao verificar pagamento ${orderCode}: ${error.message}`, error);
        return false;
    }
}

/**
 * ENVIAR EVENTO DE CONVERSÃO
 */
async function sendConversionEvent(conversation, messageContent, responseNumber) {
    try {
        const fullName = conversation.client_name || 'Cliente';
        const firstName = getFirstName(fullName);
        
        logger.info(`🎯 PIX pago - enviando convertido: ${conversation.order_code} | Resposta ${responseNumber}`);
        
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
        
        return success;
        
    } catch (error) {
        logger.error(`❌ Erro ao enviar evento de conversão: ${error.message}`, error);
        return false;
    }
}

/**
 * PROCESSAR RESPOSTA DO CLIENTE - FUNIL SEQUENCIAL COM AVANÇO POR RESPOSTA
 */
async function handleClientResponse(clientNumber, messageContent, instanceName, messageData) {
    try {
        logger.info(`📥 RESPOSTA CLIENTE: ${clientNumber} | "${messageContent.substring(0, 50)}..."`);
        
        // Buscar conversa ativa
        const conversation = await database.query(`
            SELECT id, order_code, product, status, current_step, responses_count, 
                   instance_name, client_name, amount, pix_url
            FROM conversations 
            WHERE phone = $1 AND status IN ('pix_pending', 'approved') 
            ORDER BY created_at DESC LIMIT 1
        `, [clientNumber]);
        
        if (conversation.rows.length === 0) {
            logger.warn(`⚠️ Cliente ${clientNumber} não encontrado nas conversas ativas`);
            return;
        }
        
        const conv = conversation.rows[0];
        
        // Verificar qual foi a última resposta_XX enviada pelo sistema
        const lastSystemResponse = await database.query(`
            SELECT content 
            FROM messages 
            WHERE conversation_id = $1 
              AND type = 'system_event' 
              AND content LIKE '%resposta_0%' 
              AND content LIKE '%enviada ao N8N%'
            ORDER BY created_at DESC 
            LIMIT 1
        `, [conv.id]);
        
        let nextStep = 1; // Padrão: cliente respondeu à msg01, enviar resposta_01
        
        if (lastSystemResponse.rows.length > 0) {
            const lastResponse = lastSystemResponse.rows[0].content;
            
            if (lastResponse.includes('resposta_03')) {
                // Já enviou resposta_03, funil completo
                logger.info(`✅ Funil completo - ${clientNumber} já recebeu resposta_03`);
                
                await database.query(
                    'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                    [conv.id, 'received', messageContent.substring(0, 500), 'extra']
                );
                return;
                
            } else if (lastResponse.includes('resposta_02')) {
                nextStep = 3; // Cliente respondeu à resposta_02, enviar resposta_03
            } else if (lastResponse.includes('resposta_01')) {
                nextStep = 2; // Cliente respondeu à resposta_01, enviar resposta_02
            }
        }
        
        logger.info(`📋 Cliente ${clientNumber} respondeu - enviando resposta_0${nextStep}`);
        
        // Sempre registrar a mensagem do cliente
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status, response_number) VALUES ($1, $2, $3, $4, $5)',
            [conv.id, 'received', messageContent.substring(0, 500), 'received', nextStep]
        );
        
        // Verificar se PIX foi pago durante o fluxo
        if (conv.status === 'pix_pending') {
            const isPaid = await checkPaymentStatus(conv.order_code);
            
            if (isPaid) {
                logger.info(`🎉 PIX pago durante fluxo - enviando evento convertido`);
                
                await queueService.cancelAllTimeouts(conv.order_code);
                await database.query(
                    'UPDATE conversations SET status = $1, conversion_response = $2, updated_at = NOW() WHERE id = $3',
                    ['convertido', nextStep, conv.id]
                );
                
                await sendConversionEvent(conv, messageContent, nextStep);
                return;
            }
        }
        
        // Verificar se já enviamos esta resposta específica (anti-duplicação)
        const alreadySentThisStep = await database.query(`
            SELECT COUNT(*) as count
            FROM messages 
            WHERE conversation_id = $1 
              AND type = 'system_event' 
              AND content = $2
        `, [conv.id, `resposta_0${nextStep} enviada ao N8N`]);
        
        if (parseInt(alreadySentThisStep.rows[0].count) > 0) {
            logger.info(`🔄 Resposta_0${nextStep} já foi enviada - não reenviar`);
            return;
        }
        
        // Preparar dados para N8N
        const eventData = {
            event_type: `resposta_0${nextStep}`,
            produto: conv.product,
            instancia: conv.instance_name,
            evento_origem: conv.status === 'approved' ? 'aprovada' : 'pix',
            cliente: {
                telefone: conv.phone,
                nome: getFirstName(conv.client_name || 'Cliente'),
                nome_completo: conv.client_name || 'Cliente'
            },
            resposta: {
                numero: nextStep,
                conteudo: messageContent,
                timestamp: new Date().toISOString(),
                brazil_time: getBrazilTime()
            },
            pedido: {
                codigo: conv.order_code,
                valor: conv.amount || 0,
                pix_url: conv.pix_url || ''
            },
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: conv.id
        };
        
        // Enviar ao N8N
        const success = await queueService.sendToN8N(eventData, `resposta_0${nextStep}`, conv.id);
        
        if (success) {
            logger.info(`✅ Resposta_0${nextStep} enviada ao N8N com sucesso`);
            
            // Atualizar contador de respostas na conversa
            await database.query(
                'UPDATE conversations SET responses_count = $1, last_response_at = NOW(), updated_at = NOW() WHERE id = $2',
                [nextStep, conv.id]
            );
            
            // Registrar que enviamos a resposta ao N8N
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conv.id, 'system_event', `resposta_0${nextStep} enviada ao N8N`, 'sent']
            );
            
            // Se foi a terceira resposta, marcar como completo
            if (nextStep === 3) {
                logger.info(`🎯 Funil completo após resposta_03: ${conv.order_code}`);
                
                await database.query(
                    'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2',
                    ['completed', conv.id]
                );
            }
        } else {
            logger.error(`❌ Falha ao enviar resposta_0${nextStep} ao N8N`);
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar resposta do cliente ${clientNumber}: ${error.message}`, error);
    }
}

/**
 * WEBHOOK N8N CONFIRM - CORRIGIDO
 */
app.post('/webhook/n8n-confirm', async (req, res) => {
    try {
        const { tipo_mensagem, telefone, instancia } = req.body;
        
        const phoneNormalized = normalizePhoneNumber(telefone);
        
        logger.info(`✅ N8N confirmou envio de ${tipo_mensagem}: ${phoneNormalized} via ${instancia}`);
        
        const conversation = await database.query(
            `SELECT * FROM conversations 
             WHERE phone = $1 AND status IN ('pix_pending', 'approved', 'completed') 
             ORDER BY created_at DESC LIMIT 1`,
            [phoneNormalized]
        );
        
        if (conversation.rows.length === 0) {
            logger.warn(`⚠️ Nenhuma conversa encontrada para confirmação: ${phoneNormalized}`);
            return res.json({ 
                success: false, 
                message: 'Nenhuma conversa encontrada'
            });
        }
        
        const conv = conversation.rows[0];
        
        // Registrar confirmação como system_event
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [
                conv.id, 
                'system_event',
                `N8N confirmou envio: ${tipo_mensagem} via ${instancia}`,
                'delivered'
            ]
        );
        
        logger.info(`📝 Confirmação N8N registrada para ${conv.order_code}`);
        
        const proximaResposta = conv.responses_count < 3 ? conv.responses_count + 1 : null;
        
        res.json({ 
            success: true,
            message: `${tipo_mensagem} confirmada`,
            pedido: conv.order_code,
            cliente: conv.client_name,
            respostas_atuais: conv.responses_count,
            proxima_resposta: proximaResposta ? `resposta_0${proximaResposta}` : 'Funil completo',
            status_conversa: conv.status
        });
        
    } catch (error) {
        logger.error(`❌ Erro no webhook N8N confirm: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * ENDPOINTS PARA N8N
 */
app.get('/check-payment/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        logger.info(`💳 Check payment solicitado: ${orderId}`);
        
        const conversation = await database.query(
            'SELECT status FROM conversations WHERE order_code = $1 ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        
        if (conversation.rows.length === 0) {
            logger.warn(`⚠️ Pedido não encontrado para check payment: ${orderId}`);
            return res.json({ status: 'not_found' });
        }
        
        const status = conversation.rows[0].status;
        const isPaid = status === 'approved' || status === 'completed';
        
        logger.info(`💳 Check payment ${orderId}: Status ${status} | Pago: ${isPaid}`);
        
        res.json({ 
            status: isPaid ? 'paid' : 'pending',
            order_id: orderId,
            conversation_status: status
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao verificar pagamento ${req.params.orderId}: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/complete/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        logger.info(`✅ Marcando fluxo como completo: ${orderId}`);
        
        await database.query(
            'UPDATE conversations SET status = $1, updated_at = NOW() WHERE order_code = $2',
            ['completed', orderId]
        );
        
        await queueService.cancelAllTimeouts(orderId);
        
        logger.info(`✅ Fluxo marcado como completo: ${orderId}`);
        
        res.json({ 
            success: true, 
            message: 'Fluxo marcado como completo',
            order_id: orderId
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao marcar fluxo completo ${req.params.orderId}: ${error.message}`, error);
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
            conversations,
            instanceStats
        ] = await Promise.all([
            database.query("SELECT COUNT(*) FROM conversations WHERE status = 'pix_pending'"),
            database.query("SELECT COUNT(*) FROM conversations WHERE status IN ('pix_pending', 'approved')"),
            database.query("SELECT COUNT(*) FROM leads"),
            database.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 50"),
            database.query(`
                SELECT c.*, l.instance_name as lead_instance
                FROM conversations c
                LEFT JOIN leads l ON c.phone = l.phone
                WHERE c.status IN ('pix_pending', 'approved')
                ORDER BY c.created_at DESC
            `),
            database.query(`
                SELECT instance_name, COUNT(*) as total
                FROM leads 
                GROUP BY instance_name 
                ORDER BY total DESC
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
            conversations: conversations.rows,
            instance_distribution: instanceStats.rows,
            corrections: [
                'Sistema de funil 3 etapas funcionando',
                'Webhook n8n-confirm adicionado',
                'Verificação duplicatas otimizada',
                'Logs debug completos'
            ]
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao obter status: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Diagnóstico completo
app.get('/diagnostics', async (req, res) => {
    try {
        logger.info('🔍 Executando diagnóstico completo do sistema...');
        
        const diagnostics = {
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            system_version: '3.3-CORRECTED',
            
            components: {
                database: {
                    status: database.isConnected() ? 'connected' : 'disconnected',
                    details: database.isConnected() ? 'PostgreSQL conectado' : 'PostgreSQL desconectado'
                },
                n8n: {
                    status: 'configured',
                    url: CONFIG.N8N_WEBHOOK_URL,
                    details: 'URL configurada'
                },
                evolution: {
                    status: 'configured',
                    url: CONFIG.EVOLUTION_API_URL,
                    details: 'URL configurada'
                }
            },
            
            configuration: {
                pix_timeout: `${CONFIG.PIX_TIMEOUT}ms (${Math.round(CONFIG.PIX_TIMEOUT/60000)} minutos)`,
                max_retry_attempts: CONFIG.MAX_RETRY_ATTEMPTS,
                port: PORT,
                node_env: process.env.NODE_ENV || 'development',
                instances_configured: INSTANCES.length
            },
            
            corrections_applied: [
                '✅ Webhook n8n-confirm funcionando',
                '✅ Sistema de respostas simplificado',
                '✅ Verificação duplicatas otimizada',
                '✅ Logs debug completos',
                '✅ Código limpo e funcional'
            ]
        };
        
        // Testar banco
        if (database.isConnected()) {
            try {
                const testQuery = await database.query('SELECT NOW() as current_time');
                diagnostics.components.database.last_test = testQuery.rows[0].current_time;
                diagnostics.components.database.details = 'PostgreSQL funcionando';
            } catch (error) {
                diagnostics.components.database.status = 'error';
                diagnostics.components.database.error = error.message;
            }
        }
        
        // Obter estatísticas
        try {
            const stats = await database.getStats();
            diagnostics.database_stats = stats;
        } catch (error) {
            diagnostics.recent_errors = [{
                component: 'database_stats',
                error: error.message,
                timestamp: new Date().toISOString()
            }];
        }
        
        // Testar N8N
        try {
            const testPayload = { event_type: 'system_test', teste: true };
            const response = await axios.post(CONFIG.N8N_WEBHOOK_URL, testPayload, { timeout: 5000 });
            diagnostics.components.n8n.status = 'online';
            diagnostics.components.n8n.response_status = response.status;
        } catch (error) {
            diagnostics.components.n8n.status = 'error';
            diagnostics.components.n8n.error = error.message;
        }
        
        const hasErrors = (diagnostics.recent_errors && diagnostics.recent_errors.length > 0) || !database.isConnected();
        diagnostics.overall_status = hasErrors ? 'warning' : 'healthy';
        
        res.json(diagnostics);
        
    } catch (error) {
        logger.error(`❌ Erro no diagnóstico: ${error.message}`, error);
        res.status(500).json({
            error: error.message,
            overall_status: 'error'
        });
    }
});

// Eventos recentes
app.get('/events', async (req, res) => {
    try {
        const { limit = 100, type, status } = req.query;
        
        let query = `
            SELECT m.*, c.order_code, c.product, c.client_name, c.instance_name, c.phone
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE m.type IN ('system_event', 'n8n_sent')
        `;
        
        const params = [];
        
        if (type) {
            query += ` AND m.content LIKE ${params.length + 1}`;
            params.push(`%${type}%`);
        }
        
        if (status) {
            query += ` AND m.status = ${params.length + 1}`;
            params.push(status);
        }
        
        query += ` ORDER BY m.created_at DESC LIMIT ${params.length + 1}`;
        params.push(limit);
        
        const events = await database.query(query, params);
        
        res.json({
            events: events.rows.map(event => ({
                id: event.id,
                type: event.content.split(':')[0] || 'system_event',
                date: moment(event.created_at).tz('America/Sao_Paulo').format('DD/MM/YYYY'),
                time: moment(event.created_at).tz('America/Sao_Paulo').format('HH:mm:ss'),
                clientName: event.client_name || 'Cliente',
                clientPhone: event.phone || 'N/A',
                orderCode: event.order_code || 'N/A',
                product: event.product || 'N/A',
                status: event.status === 'sent' || event.status === 'delivered' ? 'success' : 'failed',
                instance: event.instance_name || 'N/A',
                content: event.content
            }))
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao obter eventos: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Logs do sistema
app.get('/logs', async (req, res) => {
    try {
        const { limit = 50, level } = req.query;
        const logs = await logger.getRecentLogs(limit, level);
        
        res.json({ 
            logs: logs.map(log => ({
                ...log,
                level_upper: log.level.toUpperCase(),
                brazil_time_formatted: moment(log.created_at).tz('America/Sao_Paulo').format('DD/MM HH:mm:ss')
            }))
        });
    } catch (error) {
        logger.error(`❌ Erro ao obter logs: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Status das instâncias
app.get('/instances/status', async (req, res) => {
    try {
        const instancesStatus = [];
        
        const possibleEndpoints = [
            '/instance/connectionState',
            '/instance/connect',
            '/instance/fetchInstances',
            '/instance/status'
        ];
        
        for (const instance of INSTANCES) {
            let isConnected = false;
            let workingEndpoint = null;
            let responseData = null;
            
            for (const endpoint of possibleEndpoints) {
                try {
                    const response = await axios.get(`${CONFIG.EVOLUTION_API_URL}${endpoint}/${instance.name}`, {
                        timeout: 8000,
                        headers: { 'apikey': instance.id }
                    });
                    
                    responseData = response.data;
                    
                    if (response.data?.instance?.state === 'open' || 
                        response.data?.state === 'open' || 
                        response.data?.status === 'open' || 
                        response.data?.connected === true) {
                        
                        isConnected = true;
                        workingEndpoint = endpoint;
                        break;
                    }
                    
                } catch (error) {
                    continue;
                }
            }
            
            instancesStatus.push({
                name: instance.name,
                id: instance.id,
                status: isConnected ? 'online' : 'offline',
                active: isConnected,
                workingEndpoint: workingEndpoint,
                responseData: responseData,
                lastCheck: new Date().toISOString(),
                lastCheckBrazil: getBrazilTime()
            });
        }

        const onlineCount = instancesStatus.filter(i => i.status === 'online').length;
        
        res.json({
            instances: instancesStatus,
            summary: {
                total: INSTANCES.length,
                online: onlineCount,
                offline: INSTANCES.length - onlineCount,
                percentage: Math.round((onlineCount / INSTANCES.length) * 100)
            }
        });

    } catch (error) {
        logger.error(`❌ Erro ao verificar instâncias: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check das instâncias
app.post('/instances/health-check', async (req, res) => {
    try {
        const response = await axios.get(`${req.protocol}://${req.get('host')}/instances/status`);
        res.json({
            success: true,
            online: response.data.summary.online,
            total: response.data.summary.total,
            percentage: response.data.summary.percentage
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Forçar processamento da fila
app.post('/queue/process', async (req, res) => {
    try {
        logger.info('🔄 Forçando processamento da fila manualmente...');
        
        await queueService.processQueue();
        const stats = await queueService.getQueueStats();
        
        res.json({
            success: true,
            message: 'Fila processada manualmente',
            stats: stats
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao processar fila manualmente: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Debug: listar eventos pendentes
app.get('/queue/pending', async (req, res) => {
    try {
        const pendingEvents = await database.query(`
            SELECT *, 
                   EXTRACT(EPOCH FROM (scheduled_for - NOW())) as seconds_until_execution
            FROM events_queue 
            WHERE processed = false 
            ORDER BY created_at DESC
        `);
        
        res.json({
            pending_events: pendingEvents.rows.map(event => ({
                ...event,
                payload: event.payload ? JSON.parse(event.payload) : null,
                seconds_until_execution: Math.round(parseFloat(event.seconds_until_execution) || 0),
                created_brazil: moment(event.created_at).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm:ss'),
                scheduled_brazil: moment(event.scheduled_for).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm:ss')
            }))
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao obter eventos pendentes: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Teste direto do webhook N8N
app.post('/test/n8n', async (req, res) => {
    try {
        logger.info('🧪 Testando webhook N8N manualmente...');
        
        const testPayload = {
            event_type: 'pix_timeout',
            produto: 'FAB',
            instancia: 'GABY04',
            evento_origem: 'pix',
            cliente: {
                nome: 'Teste',
                telefone: '5511999999999',
                nome_completo: 'Cliente Teste'
            },
            pedido: {
                codigo: 'TEST-' + Date.now(),
                valor: 297.00,
                pix_url: 'https://exemplo.com/pix'
            },
            timeout_minutos: 7,
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            conversation_id: 999
        };
        
        const response = await axios.post(CONFIG.N8N_WEBHOOK_URL, testPayload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Sistema-Test/1.0'
            },
            timeout: 15000
        });
        
        logger.info(`✅ Teste N8N bem-sucedido: ${response.status}`);
        
        res.json({
            success: true,
            message: 'Teste N8N executado com sucesso',
            status: response.status,
            data: response.data,
            payload_sent: testPayload
        });
        
    } catch (error) {
        logger.error(`❌ Erro no teste N8N: ${error.message}`, error);
        
        res.json({
            success: false,
            error: error.message,
            status: error.response?.status,
            data: error.response?.data,
            message: 'Teste N8N falhou'
        });
    }
});

// Estatísticas da fila
app.get('/queue/stats', async (req, res) => {
    try {
        const stats = await queueService.getQueueStats();
        res.json(stats);
    } catch (error) {
        logger.error(`❌ Erro ao obter stats da fila: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Limpeza manual
app.post('/cleanup', async (req, res) => {
    try {
        await database.cleanup();
        await logger.cleanupOldLogs();
        
        const cleanupResult = await database.query(`
            DELETE FROM events_queue WHERE event_type = 'final_check'
        `);
        
        res.json({ 
            success: true, 
            message: 'Limpeza executada com sucesso',
            final_check_removed: cleanupResult.rowCount
        });
    } catch (error) {
        logger.error(`❌ Erro na limpeza: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Exportação de contatos
app.get('/contacts/export/:instance?', async (req, res) => {
    try {
        const { instance } = req.params;
        
        let query = `
            SELECT DISTINCT l.phone, l.instance_name, l.created_at, 
                   COALESCE(c.client_name, 'Cliente ' || SUBSTRING(l.phone, -4)) as client_name
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
            const date = moment(lead.created_at).tz('America/Sao_Paulo').format('DD/MM');
            const name = `${date} - ${lead.client_name}`;
            const notes = `Instância: ${lead.instance_name} | Importado: ${moment(lead.created_at).tz('America/Sao_Paulo').format('DD/MM/YYYY')}`;
            
            csv += `"${name}","${name}","${lead.phone}","${notes}"\n`;
        }
        
        const today = moment().tz('America/Sao_Paulo').format('YYYY-MM-DD');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}_${today}.csv"`);
        res.send(csv);
        
    } catch (error) {
        logger.error(`❌ Erro ao exportar contatos: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Estatísticas por instância
app.get('/contacts/instances', async (req, res) => {
    try {
        const instances = await database.query(`
            SELECT 
                instance_name, 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as last_24h,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_7d,
                MIN(created_at) as first_lead,
                MAX(created_at) as last_lead
            FROM leads 
            GROUP BY instance_name 
            ORDER BY total DESC
        `);
        
        res.json({
            instances: instances.rows.map(inst => ({
                ...inst,
                first_lead_brazil: moment(inst.first_lead).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm'),
                last_lead_brazil: moment(inst.last_lead).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm'),
                total: parseInt(inst.total),
                last_24h: parseInt(inst.last_24h),
                last_7d: parseInt(inst.last_7d)
            })),
            total: instances.rows.reduce((sum, inst) => sum + parseInt(inst.total), 0)
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao obter estatísticas de instâncias: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint de debug telefone
app.post('/debug/normalize-phone', async (req, res) => {
    try {
        const { phone } = req.body;
        
        if (!phone) {
            return res.status(400).json({ error: 'Telefone é obrigatório' });
        }
        
        const normalized = normalizePhoneNumber(phone);
        
        const result = {
            original: phone,
            normalized: normalized,
            steps: [
                `1. Original: "${phone}"`,
                `2. Convertido para string: "${String(phone).trim()}"`,
                `3. Removidos caracteres não-numéricos: "${String(phone).replace(/\D/g, '')}"`,
                `4. Normalizado final: "${normalized}"`,
                `5. Comprimento final: ${normalized.length} dígitos`
            ],
            is_valid: normalized.length >= 13,
            format_detected: normalized.length === 13 ? 'Brasileiro padrão' : 'Formato não padrão'
        };
        
        res.json(result);
        
    } catch (error) {
        logger.error(`❌ Erro no debug de telefone: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

// Health check simples
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        version: '3.3-CORRECTED',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        database: database.isConnected() ? 'connected' : 'disconnected',
        corrections: [
            'Webhook n8n-confirm funcionando',
            'Sistema respostas simplificado',
            'Verificação duplicatas otimizada',
            'Código limpo e funcional'
        ]
    });
});

/**
 * VALIDAÇÕES DE INICIALIZAÇÃO
 */
async function validateSystemInitialization() {
    const errors = [];
    
    logger.info('🔧 Executando validações de inicialização...');
    
    // Verificar .env
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
        errors.push('❌ Arquivo .env não encontrado');
    }
    
    // Verificar variáveis obrigatórias
    const requiredVars = ['DATABASE_URL', 'N8N_WEBHOOK_URL', 'EVOLUTION_API_URL'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        errors.push(`❌ Variáveis ausentes: ${missingVars.join(', ')}`);
    }
    
    // Validar URLs
    if (process.env.N8N_WEBHOOK_URL) {
        try {
            new URL(CONFIG.N8N_WEBHOOK_URL);
        } catch (error) {
            errors.push(`❌ N8N_WEBHOOK_URL inválida: ${CONFIG.N8N_WEBHOOK_URL}`);
        }
    }
    
    if (process.env.EVOLUTION_API_URL) {
        try {
            new URL(CONFIG.EVOLUTION_API_URL);
        } catch (error) {
            errors.push(`❌ EVOLUTION_API_URL inválida: ${CONFIG.EVOLUTION_API_URL}`);
        }
    }
    
    if (errors.length > 0) {
        logger.error('🔥 ERROS CRÍTICOS DE INICIALIZAÇÃO:');
        errors.forEach((error, index) => {
            logger.error(`${index + 1}. ${error}`);
        });
        
        throw new Error(`${errors.length} erro(s) crítico(s) encontrado(s)`);
    }
    
    logger.info('✅ Validações básicas concluídas');
}

/**
 * INICIALIZAÇÃO DO SISTEMA
 */
async function initializeSystem() {
    try {
        logger.info('🧠 Inicializando Cérebro de Atendimento v3.3 CORRIGIDA...');
        
        await validateSystemInitialization();
        
        logger.info('🔌 Conectando ao banco de dados...');
        await database.connect();
        logger.info('✅ Conexão PostgreSQL estabelecida');
        
        logger.setDatabase(database);
        logger.info('✅ Logger conectado ao banco');
        
        logger.info('📋 Executando migrações do banco...');
        await database.migrate();
        logger.info('✅ Migrações executadas');
        
        logger.info('⚙️ Inicializando serviços...');
        await queueService.initialize();
        logger.info('✅ Sistema de filas inicializado');
        
        try {
            logger.info('📱 Inicializando Evolution Service...');
            await evolutionService.initialize();
            logger.info('✅ Evolution Service inicializado');
        } catch (error) {
            logger.warn('⚠️ Evolution Service falhou, continuando...');
        }
        
        logger.info('🔄 Recuperando timeouts perdidos...');
        await queueService.recoverTimeouts();
        logger.info('✅ Timeouts recuperados');
        
        logger.info('🚀 Sistema v3.3 inicializado com sucesso');
        
    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${error.message}`, error);
        
        console.error('\n🔥 SISTEMA NÃO PODE INICIAR 🔥');
        console.error('=====================================');
        console.error('Erro:', error.message);
        console.error('\n🔧 VERIFICAR:');
        console.error('1. Arquivo .env existe');
        console.error('2. PostgreSQL rodando');
        console.error('3. Credenciais corretas');
        console.error('4. URLs válidas');
        console.error('=====================================\n');
        
        process.exit(1);
    }
}

/**
 * TRATAMENTO DE ERROS
 */
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    logger.info('🔄 Finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('✅ Sistema finalizado');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('🔄 Finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('✅ Sistema finalizado');
    process.exit(0);
});

/**
 * INICIAR SERVIDOR
 */
initializeSystem().then(() => {
    app.listen(PORT, () => {
        logger.info(`🧠 Cérebro de Atendimento v3.3 rodando na porta ${PORT}`);
        
        console.log('\n🧠 CÉREBRO DE ATENDIMENTO v3.3 - VERSÃO CORRIGIDA E FUNCIONAL');
        console.log('=================================================================');
        console.log(`📡 Webhooks:`);
        console.log(`   Perfect Pay: http://localhost:${PORT}/webhook/perfect`);
        console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
        console.log(`   N8N Confirm: http://localhost:${PORT}/webhook/n8n-confirm`);
        console.log(`🎯 N8N: ${CONFIG.N8N_WEBHOOK_URL}`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        console.log(`🔍 Diagnóstico: http://localhost:${PORT}/diagnostics`);
        console.log(`💳 Check Payment: http://localhost:${PORT}/check-payment/:orderId`);
        console.log(`✅ Complete Flow: http://localhost:${PORT}/webhook/complete/:orderId`);
        console.log(`⏰ Horário: ${getBrazilTime()}`);
        console.log(`🗃️ PostgreSQL: ${database.isConnected() ? 'Conectado ✅' : 'Desconectado ❌'}`);
        console.log('\n🚀 PRINCIPAIS CORREÇÕES v3.3:');
        console.log(`   ✅ Webhook n8n-confirm funcionando corretamente`);
        console.log(`   ✅ Sistema de respostas simplificado e confiável`);
        console.log(`   ✅ Verificação de duplicatas otimizada`);
        console.log(`   ✅ Logs de debug completos`);
        console.log(`   ✅ Código limpo e organizado`);
        console.log('\n🎯 FUNCIONAMENTO DO FUNIL:');
        console.log(`   1️⃣ Cliente responde → resposta_01 enviada ao N8N`);
        console.log(`   2️⃣ Cliente responde → resposta_02 enviada ao N8N`);
        console.log(`   3️⃣ Cliente responde → resposta_03 enviada ao N8N + Funil completo`);
        console.log(`   🎉 N8N confirma envios via webhook /webhook/n8n-confirm`);
        console.log('=================================================================\n');
    });
}).catch(error => {
    logger.error(`❌ Falha crítica ao iniciar servidor: ${error.message}`, error);
    process.exit(1);
});
