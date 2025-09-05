require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const moment = require('moment-timezone');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const database = require('./database/config');
const evolutionService = require('./services/evolution');
const queueService = require('./services/queue');
const logger = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
    PIX_TIMEOUT: parseInt(process.env.PIX_TIMEOUT) || 420000,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n',
    EVOLUTION_API_URL: process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun',
    MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3
};

const PRODUCT_MAPPING = {
    'PPLQQM9AP': 'FAB',
    'PPLQQMAGU': 'FAB', 
    'PPLQQMADF': 'FAB',
    'PPLQQN0FT': 'NAT',
    'PPLQQMSFH': 'CS',
    'PPLQQMSFI': 'CS'
};

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

let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

function normalizePhoneNumber(phone) {
    if (!phone) {
        logger.debug('Telefone vazio recebido para normalização');
        return phone;
    }
    
    logger.debug(`Normalizando telefone: "${phone}"`);
    
    let cleanPhone = String(phone).trim();
    cleanPhone = cleanPhone.replace(/\D/g, '');
    
    logger.debug(`Telefone após limpeza: "${cleanPhone}" (length: ${cleanPhone.length})`);
    
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
    
    logger.debug(`Telefone normalizado final: "${cleanPhone}"`);
    return cleanPhone;
}

function formatPhoneFromPerfectPay(extension, areaCode, number) {
    const ext = extension || '55';
    const area = areaCode || '';
    const num = number || '';
    
    const fullNumber = ext + area + num;
    
    logger.debug(`Formatando Perfect Pay: ext="${ext}", area="${area}", num="${num}" -> "${fullNumber}"`);
    
    return normalizePhoneNumber(fullNumber);
}

function getBrazilTime(format = 'YYYY-MM-DD HH:mm:ss') {
    return moment().tz('America/Sao_Paulo').format(format);
}

function getProductByPlanCode(planCode) {
    return PRODUCT_MAPPING[planCode] || 'UNKNOWN';
}

function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0].trim() : 'Cliente';
}

async function getInstanceForClient(clientNumber) {
    try {
        const normalizedPhone = normalizePhoneNumber(clientNumber);
        logger.info(`🔍 Verificando instância para cliente: ${normalizedPhone}`);
        
        const existingLead = await database.query(
            'SELECT instance_name FROM leads WHERE phone = $1',
            [normalizedPhone]
        );
        
        if (existingLead.rows.length > 0) {
            const instanceName = existingLead.rows[0].instance_name;
            logger.info(`👤 Cliente ${normalizedPhone} já atribuído à instância ${instanceName}`);
            return instanceName;
        }
        
        const instanceLoad = await database.query(`
            SELECT instance_name, COUNT(*) as lead_count 
            FROM leads 
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY instance_name
            ORDER BY lead_count ASC
        `);
        
        logger.debug('Carga atual das instâncias:', instanceLoad.rows);
        
        let selectedInstance = 'GABY01';
        
        if (instanceLoad.rows.length === 0) {
            selectedInstance = INSTANCES[0].name;
            logger.info(`📍 Primeira atribuição - usando ${selectedInstance}`);
        } else {
            const currentLoads = {};
            instanceLoad.rows.forEach(row => {
                currentLoads[row.instance_name] = parseInt(row.lead_count);
            });
            
            let minLoad = Infinity;
            for (const instance of INSTANCES) {
                if (!instance.active) continue;
                
                const load = currentLoads[instance.name] || 0;
                logger.debug(`📊 ${instance.name}: ${load} leads`);
                
                if (load < minLoad) {
                    minLoad = load;
                    selectedInstance = instance.name;
                }
            }
            
            logger.info(`⚖️ Balanceamento: ${selectedInstance} selecionada com ${minLoad} leads`);
        }
        
        await database.query(
            'INSERT INTO leads (phone, instance_name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET instance_name = $2, updated_at = NOW()',
            [normalizedPhone, selectedInstance]
        );
        
        logger.info(`✅ Cliente ${normalizedPhone} atribuído à instância ${selectedInstance}`);
        return selectedInstance;
        
    } catch (error) {
        logger.error(`Erro ao obter instância para cliente ${clientNumber}: ${error.message}`, error);
        return 'GABY01';
    }
}

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
        
        logger.info(`📥 PERFECT PAY WEBHOOK:`, {
            orderCode,
            status,
            product,
            phoneNumber,
            firstName,
            amount
        });

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
        logger.error(`❌ Erro no webhook Perfect Pay: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function handleApprovedSale(orderCode, phoneNumber, firstName, fullName, product, amount, originalData) {
    try {
        logger.info(`💰 VENDA APROVADA: ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Telefone: ${phoneNumber}`);
        
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
        if (success) {
            systemStats.successfulEvents++;
            logger.info(`✅ Venda aprovada processada com sucesso: ${orderCode}`);
        } else {
            systemStats.failedEvents++;
            logger.error(`❌ Falha ao processar venda aprovada: ${orderCode}`);
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar venda aprovada ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

async function handlePendingPix(orderCode, phoneNumber, firstName, fullName, product, amount, pixUrl, planCode, originalData) {
    try {
        logger.info(`⏰ PIX GERADO: ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Telefone: ${phoneNumber}`);
        
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
        
        logger.info(`✅ PIX pendente registrado: ${orderCode} | Timeout em 7 minutos`);
        
    } catch (error) {
        logger.error(`❌ Erro ao processar PIX pendente ${orderCode}: ${error.message}`, error);
        systemStats.failedEvents++;
    }
}

app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        
        logger.debug(`📱 Evolution webhook recebido:`, {
            instance: data.instance,
            event: data.event,
            hasData: !!data.data,
            dataKeys: data.data ? Object.keys(data.data) : []
        });
        
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
        
        logger.info(`📱 Evolution processando:`, {
            remoteJid,
            fromMe,
            clientNumber,
            instanceName,
            contentPreview: messageContent.substring(0, 50) + '...'
        });
        
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

async function handleSystemMessage(clientNumber, messageContent, instanceName) {
    try {
        logger.info(`📤 Mensagem do sistema registrada: ${clientNumber} | "${messageContent.substring(0, 50)}..."`);
        
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
            
            logger.info(`✅ Mensagem do sistema registrada para ${clientNumber}`);
        } else {
            logger.warn(`⚠️ Conversa não encontrada para registrar mensagem do sistema: ${clientNumber}`);
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar mensagem do sistema para ${clientNumber}: ${error.message}`, error);
    }
}

async function checkPaymentStatus(orderCode) {
    try {
        logger.debug(`🔍 Verificando status de pagamento: ${orderCode}`);
        
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
        
        logger.warn(`⚠️ Pedido não encontrado para verificação de pagamento: ${orderCode}`);
        return false;
        
    } catch (error) {
        logger.error(`❌ Erro ao verificar pagamento ${orderCode}: ${error.message}`, error);
        return false;
    }
}

async function sendConversionEvent(conversation, messageContent, responseNumber) {
    try {
        const fullName = conversation.client_name || 'Cliente';
        const firstName = getFirstName(fullName);
        
        logger.info(`🎯 PIX pago detectado - enviando evento convertido: ${conversation.order_code} | Resposta ${responseNumber}`);
        
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
        
        logger.info(`${success ? '✅' : '❌'} Evento de conversão: ${conversation.order_code}`);
        
        return success;
        
    } catch (error) {
        logger.error(`❌ Erro ao enviar evento de conversão: ${error.message}`, error);
        return false;
    }
}

async function handleClientResponse(clientNumber, messageContent, instanceName, messageData) {
    try {
        logger.info(`📥 RESPOSTA DO CLIENTE: ${clientNumber} | "${messageContent.substring(0, 50)}..."`);
        
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
        const currentResponseCount = conv.responses_count ?? 0;
        
        logger.info(`💬 Conversa encontrada: ${conv.order_code} | Status: ${conv.status} | Respostas atuais: ${currentResponseCount}`);
        
        if (currentResponseCount >= 3) {
            logger.info(`✅ Funil completo - ${clientNumber} já passou por todas as 3 etapas`);
            
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conv.id, 'received', messageContent.substring(0, 500), 'extra']
            );
            return;
        }
        
        const expectedResponseNumber = currentResponseCount + 1;
        
        const existingResponseForStep = await database.query(`
            SELECT COUNT(*) as count
            FROM messages 
            WHERE conversation_id = $1 
              AND type = 'received' 
              AND response_number = $2
        `, [conv.id, expectedResponseNumber]);
        
        if (parseInt(existingResponseForStep.rows[0].count) > 0) {
            logger.info(`🔄 Etapa ${expectedResponseNumber} já processada - ignorando resposta duplicada`);
            
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conv.id, 'received', messageContent.substring(0, 500), 'duplicate']
            );
            return;
        }
        
        const newResponseCount = expectedResponseNumber;
        
        logger.info(`✅ Processando resposta ${newResponseCount} do cliente ${clientNumber}`);
        
        await database.query(
            'UPDATE conversations SET responses_count = $1, last_response_at = NOW(), updated_at = NOW() WHERE id = $2',
            [newResponseCount, conv.id]
        );
        
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status, response_number) VALUES ($1, $2, $3, $4, $5)',
            [conv.id, 'received', messageContent.substring(0, 500), 'received', newResponseCount]
        );
        
        if (conv.status === 'pix_pending') {
            logger.info(`💳 Verificando pagamento PIX antes de enviar resposta_0${newResponseCount}`);
            
            const isPaid = await checkPaymentStatus(conv.order_code);
            
            if (isPaid) {
                logger.info(`🎉 PIX pago durante fluxo - convertendo e finalizando`);
                
                await queueService.cancelAllTimeouts(conv.order_code);
                await database.query(
                    'UPDATE conversations SET status = $1, conversion_response = $2, updated_at = NOW() WHERE id = $3',
                    ['convertido', newResponseCount, conv.id]
                );
                
                await sendConversionEvent(conv, messageContent, newResponseCount);
                return;
            }
        }
        
        logger.info(`📤 Preparando para enviar resposta_0${newResponseCount} ao N8N`);
        
        const eventData = {
            event_type: `resposta_0${newResponseCount}`,
            produto: conv.product,
            instancia: conv.instance_name,
            evento_origem: conv.status === 'approved' ? 'aprovada' : 'pix',
            cliente: {
                telefone: conv.phone,
                nome: getFirstName(conv.client_name || 'Cliente'),
                nome_completo: conv.client_name || 'Cliente'
            },
            resposta: {
                numero: newResponseCount,
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
        
        const success = await queueService.sendToN8N(eventData, `resposta_0${newResponseCount}`, conv.id);
        
        if (success) {
            logger.info(`✅ Resposta ${newResponseCount} enviada ao N8N com sucesso`);
            
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conv.id, 'system_event', `resposta_0${newResponseCount} enviada ao N8N`, 'sent']
            );
            
            if (newResponseCount === 3) {
                logger.info(`🎯 Funil completo após 3 respostas - finalizando conversa ${conv.order_code}`);
                
                await database.query(
                    'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2',
                    ['completed', conv.id]
                );
            }
        } else {
            logger.error(`❌ Falha ao enviar resposta ${newResponseCount} ao N8N`);
        }
        
    } catch (error) {
        logger.error(`❌ Erro ao processar resposta do cliente ${clientNumber}: ${error.message}`, error);
    }
}

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
        
        await database.query(
            'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
            [
                conv.id, 
                'system_event',
                `N8N confirmou envio: ${tipo_mensagem} via ${instancia}`,
                'delivered'
            ]
        );
        
        logger.info(`📝 Confirmação registrada para ${conv.order_code}`);
        
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

app.get('/diagnostics', async (req, res) => {
    try {
        logger.info('🔍 Executando diagnóstico completo do sistema v3.3...');
        
        const diagnostics = {
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            system_version: '3.3-OPTIMIZED',
            
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
                '✅ Sistema de funil de 3 etapas funcionando',
                '✅ Duplicação de código removida',
                '✅ Verificação de respostas por response_number',
                '✅ Webhook n8n-confirm usando system_event',
                '✅ Fluxo completo sem travamento'
            ]
        };
        
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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

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
            instance_distribution: instanceStats.rows
        });
        
    } catch (error) {
        logger.error(`❌ Erro ao obter status: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/queue/stats', async (req, res) => {
    try {
        const stats = await queueService.getQueueStats();
        res.json(stats);
    } catch (error) {
        logger.error(`❌ Erro ao obter stats da fila: ${error.message}`, error);
        res.status(500).json({ error: error.message });
    }
});

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

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        version: '3.3-OPTIMIZED',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        database: database.isConnected() ? 'connected' : 'disconnected',
        corrections: [
            'Funil 3 etapas funcionando',
            'Código otimizado e limpo',
            'Sem duplicações',
            'Sistema de respostas corrigido'
        ]
    });
});

async function validateSystemInitialization() {
    const errors = [];
    const warnings = [];
    
    logger.info('🔧 Executando validações críticas de inicialização...');
    
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
        errors.push('❌ Arquivo .env não encontrado. Crie baseado no exemplo com credenciais reais.');
    }
    
    const requiredVars = ['DATABASE_URL', 'N8N_WEBHOOK_URL', 'EVOLUTION_API_URL'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        errors.push(`❌ Variáveis ausentes: ${missingVars.join(', ')}`);
    }
    
    if (process.env.N8N_WEBHOOK_URL) {
        try {
            new URL(CONFIG.N8N_WEBHOOK_URL);
            logger.debug('✅ N8N_WEBHOOK_URL válida');
        } catch (error) {
            errors.push(`❌ N8N_WEBHOOK_URL inválida: ${CONFIG.N8N_WEBHOOK_URL}`);
        }
    }
    
    if (process.env.EVOLUTION_API_URL) {
        try {
            new URL(CONFIG.EVOLUTION_API_URL);
            logger.debug('✅ EVOLUTION_API_URL válida');
        } catch (error) {
            errors.push(`❌ EVOLUTION_API_URL inválida: ${CONFIG.EVOLUTION_API_URL}`);
        }
    }
    
    logger.debug('✅ Validações básicas concluídas - banco será testado na conexão');
    
    if (errors.length > 0) {
        logger.error('🔥 ERROS CRÍTICOS DE INICIALIZAÇÃO:');
        errors.forEach((error, index) => {
            logger.error(`${index + 1}. ${error}`);
        });
        
        throw new Error(`${errors.length} erro(s) crítico(s) encontrado(s)`);
    }
    
    if (warnings.length > 0) {
        logger.warn('⚠️ AVISOS:');
        warnings.forEach((warning, index) => {
            logger.warn(`${index + 1}. ${warning}`);
        });
    }
    
    logger.info('✅ Validações básicas passaram - prosseguindo para conexão do banco');
}

async function initializeSystem() {
    try {
        logger.info('🧠 Inicializando Cérebro de Atendimento v3.3 OTIMIZADA...');
        
        await validateSystemInitialization();
        
        logger.info('🔌 Conectando ao banco de dados...');
        await database.connect();
        logger.info('✅ Conexão PostgreSQL estabelecida e testada');
        
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
            logger.warn('⚠️ Evolution Service falhou, continuando sem health check automático');
            logger.debug(`Detalhes do erro Evolution: ${error.message}`);
        }
        
        logger.info('🔄 Recuperando timeouts perdidos...');
        await queueService.recoverTimeouts();
        logger.info('✅ Timeouts recuperados');
        
        try {
            const result = await database.query(`DELETE FROM events_queue WHERE event_type = 'final_check'`);
            if (result.rowCount > 0) {
                logger.info(`✅ ${result.rowCount} eventos final_check limpos do banco`);
            } else {
                logger.debug('ℹ️ Nenhum evento final_check encontrado para limpar');
            }
        } catch (error) {
            logger.debug('Info: Tabela events_queue pode não existir ainda ou estar vazia');
        }
        
        logger.info('🚀 Sistema v3.3 inicializado com TODAS as correções aplicadas');
        
    } catch (error) {
        logger.error(`❌ Erro crítico na inicialização: ${error.message}`, error);
        
        console.error('\n🔥 SISTEMA NÃO PODE INICIAR 🔥');
        console.error('=====================================');
        console.error('Erro:', error.message);
        console.error('\n🔧 DIAGNÓSTICO:');
        console.error('1. Verificar se arquivo .env existe');
        console.error('2. Verificar se PostgreSQL está rodando');
        console.error('3. Testar credenciais do banco manualmente');
        console.error('4. Verificar conectividade de rede');
        console.error('\n📋 VARIÁVEIS NECESSÁRIAS:');
        console.error('- DATABASE_URL (ou DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
        console.error('- N8N_WEBHOOK_URL');
        console.error('- EVOLUTION_API_URL');
        console.error('=====================================\n');
        
        process.exit(1);
    }
}

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    logger.info('🔄 Recebido SIGINT, finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('✅ Sistema finalizado');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('🔄 Recebido SIGTERM, finalizando sistema...');
    await queueService.cleanup();
    await database.disconnect();
    logger.info('✅ Sistema finalizado');
    process.exit(0);
});

initializeSystem().then(() => {
    app.listen(PORT, () => {
        logger.info(`🧠 Cérebro de Atendimento v3.3 rodando na porta ${PORT}`);
        
        console.log('\n🧠 CÉREBRO DE ATENDIMENTO v3.3 - VERSÃO OTIMIZADA E CORRIGIDA');
        console.log('=========================================================');
        console.log(`📡 Webhooks configurados:`);
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
        console.log('\n🚀 CORREÇÕES APLICADAS v3.3:');
        console.log(`   ✅ Sistema de funil de 3 etapas funcionando`);
        console.log(`   ✅ Verificação de respostas por response_number`);
        console.log(`   ✅ Webhook n8n-confirm usando system_event`);
        console.log(`   ✅ Código limpo e otimizado`);
        console.log(`   ✅ Sem duplicações de funções`);
        console.log('\n🎯 FUNCIONAMENTO DO FUNIL:');
        console.log(`   1️⃣ Cliente responde → Sistema envia resposta_01 ao N8N`);
        console.log(`   2️⃣ Cliente responde novamente → Sistema envia resposta_02 ao N8N`);
        console.log(`   3️⃣ Cliente responde terceira vez → Sistema envia resposta_03 ao N8N`);
        console.log(`   ✅ Funil finalizado após 3 respostas`);
        console.log('=========================================================\n');
    });
}).catch(error => {
    logger.error(`❌ Falha crítica ao iniciar servidor: ${error.message}`, error);
    process.exit(1);
});
