/**
 * SISTEMA DE FILAS E TIMEOUTS
 * Gerencia timeouts de PIX, verificações de pagamento e envios para N8N
 */

const axios = require('axios');
const database = require('../database/config');
const logger = require('./logger');

class QueueService {
    constructor() {
        this.activeTimeouts = new Map(); // { orderId: timeoutId }
        this.retryAttempts = new Map(); // { eventId: attemptCount }
        this.isInitialized = false;
    }

    /**
     * Inicializar serviço de filas
     */
    async initialize() {
        try {
            this.isInitialized = true;
            
            // Processar eventos pendentes na fila
            setInterval(() => {
                this.processQueue();
            }, 30000); // A cada 30 segundos
            
            logger.info('Sistema de filas inicializado');
            
        } catch (error) {
            logger.error(`Erro ao inicializar sistema de filas: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Adicionar timeout de PIX (7 minutos)
     */
    async addPixTimeout(orderCode, conversationId, timeoutMs) {
        try {
            // Cancelar timeout existente se houver
            if (this.activeTimeouts.has(orderCode)) {
                clearTimeout(this.activeTimeouts.get(orderCode));
                this.activeTimeouts.delete(orderCode);
            }

            // Criar evento na fila para processar após timeout
            const scheduledFor = new Date(Date.now() + timeoutMs);
            
            await database.query(`
                INSERT INTO events_queue 
                (event_type, order_code, conversation_id, scheduled_for, payload)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                'pix_timeout',
                orderCode,
                conversationId,
                scheduledFor,
                JSON.stringify({ orderCode, conversationId, timeoutMs })
            ]);

            // Criar timeout em memória
            const timeoutId = setTimeout(async () => {
                await this.handlePixTimeout(orderCode, conversationId);
                this.activeTimeouts.delete(orderCode);
            }, timeoutMs);

            this.activeTimeouts.set(orderCode, timeoutId);

            logger.info(`Timeout PIX agendado: ${orderCode} em ${timeoutMs}ms`);

        } catch (error) {
            logger.error(`Erro ao agendar timeout PIX ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Adicionar verificação final (25 minutos após 3ª resposta)
     */
    async addFinalCheck(orderCode, conversationId, delayMs) {
        try {
            const scheduledFor = new Date(Date.now() + delayMs);
            
            await database.query(`
                INSERT INTO events_queue 
                (event_type, order_code, conversation_id, scheduled_for, payload)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                'final_check',
                orderCode,
                conversationId,
                scheduledFor,
                JSON.stringify({ orderCode, conversationId, delayMs })
            ]);

            // Criar timeout em memória
            const timeoutId = setTimeout(async () => {
                await this.handleFinalCheck(orderCode, conversationId);
                this.activeTimeouts.delete(`final_${orderCode}`);
            }, delayMs);

            this.activeTimeouts.set(`final_${orderCode}`, timeoutId);

            logger.info(`Verificação final agendada: ${orderCode} em ${delayMs}ms (25 minutos)`);

        } catch (error) {
            logger.error(`Erro ao agendar verificação final ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Processar timeout de PIX (7 minutos sem pagamento)
     */
    async handlePixTimeout(orderCode, conversationId) {
        try {
            logger.info(`Processando timeout PIX: ${orderCode}`);

            // Verificar se ainda está pendente (não foi pago enquanto isso)
            const conversation = await database.query(
                'SELECT * FROM conversations WHERE id = $1 AND status = $2',
                [conversationId, 'pix_pending']
            );

            if (conversation.rows.length === 0) {
                logger.info(`PIX ${orderCode} não está mais pendente - timeout cancelado`);
                return;
            }

            const conv = conversation.rows[0];

            // Atualizar status para timeout
            await database.query(
                'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2',
                ['timeout', conversationId]
            );

            // Buscar dados do cliente
            const fullName = conv.client_name || 'Cliente';
            const firstName = this.getFirstName(fullName);

            // Preparar dados para N8N
            const eventData = {
                event_type: 'pix_timeout',
                produto: conv.product,
                instancia: conv.instance_name,
                evento_origem: 'pix',
                cliente: {
                    nome: firstName,
                    telefone: conv.phone,
                    nome_completo: fullName
                },
                pedido: {
                    codigo: orderCode,
                    valor: conv.amount || 0,
                    pix_url: conv.pix_url || ''
                },
                timestamp: new Date().toISOString(),
                brazil_time: this.getBrazilTime(),
                conversation_id: conversationId
            };

            // Enviar para N8N
            const success = await this.sendToN8N(eventData, 'pix_timeout', conversationId);

            if (success) {
                logger.info(`Timeout PIX enviado com sucesso: ${orderCode}`);
            } else {
                logger.error(`Falha ao enviar timeout PIX: ${orderCode}`);
            }

        } catch (error) {
            logger.error(`Erro ao processar timeout PIX ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Processar verificação final (após 25 minutos da 3ª resposta)
     */
    async handleFinalCheck(orderCode, conversationId) {
        try {
            logger.info(`Processando verificação final: ${orderCode}`);

            // Verificar status atual da conversa
            const conversation = await database.query(
                'SELECT * FROM conversations WHERE id = $1',
                [conversationId]
            );

            if (conversation.rows.length === 0) {
                logger.warn(`Conversa ${conversationId} não encontrada para verificação final`);
                return;
            }

            const conv = conversation.rows[0];

            // Se ainda não foi pago/completado, enviar mensagem final
            if (conv.status !== 'completed' && conv.status !== 'approved') {
                logger.info(`Cliente ${conv.phone} não pagou em 25 minutos - enviando mensagem final`);

                // Buscar dados do cliente
                const fullName = conv.client_name || 'Cliente';
                const firstName = this.getFirstName(fullName);

                // Preparar dados para N8N (mensagem final)
                const eventData = {
                    event_type: 'mensagem_final',
                    produto: conv.product,
                    instancia: conv.instance_name,
                    evento_origem: conv.status,
                    cliente: {
                        nome: firstName,
                        telefone: conv.phone,
                        nome_completo: fullName
                    },
                    pedido: {
                        codigo: orderCode,
                        valor: conv.amount || 0,
                        pix_url: conv.pix_url || ''
                    },
                    timestamp: new Date().toISOString(),
                    brazil_time: this.getBrazilTime(),
                    conversation_id: conversationId
                };

                // Enviar para N8N
                const success = await this.sendToN8N(eventData, 'mensagem_final', conversationId);

                if (success) {
                    // Marcar como finalizado
                    await database.query(
                        'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2',
                        ['finalized', conversationId]
                    );
                    
                    logger.info(`Mensagem final enviada e conversa finalizada: ${orderCode}`);
                } else {
                    logger.error(`Falha ao enviar mensagem final: ${orderCode}`);
                }

            } else {
                logger.info(`Cliente ${conv.phone} já pagou - verificação final cancelada: ${orderCode}`);
            }

        } catch (error) {
            logger.error(`Erro na verificação final ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Enviar dados para N8N com retry automático
     */
    async sendToN8N(eventData, eventType, conversationId, attempt = 1) {
        const maxAttempts = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;
        
        try {
            logger.info(`Enviando para N8N (tentativa ${attempt}): ${eventType}`);

            const response = await axios.post(process.env.N8N_WEBHOOK_URL, eventData, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Cerebro-Evolution-v3/1.0'
                },
                timeout: 15000
            });

            // Registrar sucesso
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'n8n_sent', `${eventType}: ${response.status}`, 'delivered']
            );

            logger.info(`N8N enviado com sucesso: ${eventType} | Status: ${response.status}`);
            return true;

        } catch (error) {
            const errorMessage = error.response ? 
                `HTTP ${error.response.status}: ${error.response.statusText}` : 
                error.message;

            logger.error(`Erro ao enviar para N8N (tentativa ${attempt}): ${errorMessage}`);

            // Registrar falha
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'n8n_sent', `${eventType}: ERRO - ${errorMessage}`, 'failed']
            );

            // Tentar novamente se não excedeu limite
            if (attempt < maxAttempts) {
                const delay = attempt * 2000; // 2s, 4s, 6s...
                logger.info(`Tentando novamente em ${delay}ms...`);
                
                setTimeout(() => {
                    this.sendToN8N(eventData, eventType, conversationId, attempt + 1);
                }, delay);
                
                return false;
            } else {
                logger.error(`Máximo de tentativas excedido para ${eventType}`);
                
                // Adicionar à fila para reprocessamento manual
                await database.query(`
                    INSERT INTO events_queue 
                    (event_type, conversation_id, payload, processed, attempts, max_attempts)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [eventType, conversationId, JSON.stringify(eventData), false, maxAttempts, maxAttempts]);
                
                return false;
            }
        }
    }

    /**
     * Cancelar PIX pendente (quando venda é aprovada)
     */
    async cancelPendingPix(orderCode) {
        try {
            // Cancelar timeout em memória
            if (this.activeTimeouts.has(orderCode)) {
                clearTimeout(this.activeTimeouts.get(orderCode));
                this.activeTimeouts.delete(orderCode);
                logger.info(`Timeout PIX cancelado: ${orderCode}`);
            }

            // Marcar eventos relacionados como processados no banco
            await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND event_type = 'pix_timeout' AND processed = false
            `, [orderCode]);

            logger.info(`PIX pendente cancelado: ${orderCode}`);

        } catch (error) {
            logger.error(`Erro ao cancelar PIX pendente ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Cancelar todos os timeouts de um pedido
     */
    async cancelAllTimeouts(orderCode) {
        try {
            // Cancelar timeout principal
            if (this.activeTimeouts.has(orderCode)) {
                clearTimeout(this.activeTimeouts.get(orderCode));
                this.activeTimeouts.delete(orderCode);
            }

            // Cancelar timeout de verificação final
            const finalKey = `final_${orderCode}`;
            if (this.activeTimeouts.has(finalKey)) {
                clearTimeout(this.activeTimeouts.get(finalKey));
                this.activeTimeouts.delete(finalKey);
            }

            // Marcar eventos no banco como processados
            await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND processed = false
            `, [orderCode]);

            logger.info(`Todos os timeouts cancelados: ${orderCode}`);

        } catch (error) {
            logger.error(`Erro ao cancelar timeouts ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Processar fila de eventos pendentes
     */
    async processQueue() {
        try {
            // Buscar eventos que devem ser processados agora
            const pendingEvents = await database.query(`
                SELECT * FROM events_queue 
                WHERE processed = false 
                AND scheduled_for <= NOW() 
                AND attempts < max_attempts
                ORDER BY created_at ASC
                LIMIT 10
            `);

            for (const event of pendingEvents.rows) {
                try {
                    logger.info(`Processando evento da fila: ${event.event_type} | ${event.order_code}`);

                    // Incrementar tentativas
                    await database.query(
                        'UPDATE events_queue SET attempts = attempts + 1, last_attempt = NOW() WHERE id = $1',
                        [event.id]
                    );

                    let processed = false;

                    if (event.event_type === 'pix_timeout') {
                        await this.handlePixTimeout(event.order_code, event.conversation_id);
                        processed = true;
                    } else if (event.event_type === 'final_check') {
                        await this.handleFinalCheck(event.order_code, event.conversation_id);
                        processed = true;
                    } else if (event.payload) {
                        // Tentar reenviar evento falhou
                        const payload = JSON.parse(event.payload);
                        processed = await this.sendToN8N(payload, event.event_type, event.conversation_id);
                    }

                    // Marcar como processado se bem-sucedido
                    if (processed) {
                        await database.query(
                            'UPDATE events_queue SET processed = true WHERE id = $1',
                            [event.id]
                        );
                    }

                } catch (error) {
                    logger.error(`Erro ao processar evento ${event.id}: ${error.message}`, error);
                }
            }

        } catch (error) {
            logger.error(`Erro ao processar fila: ${error.message}`, error);
        }
    }

    /**
     * Recuperar timeouts do banco (após restart)
     */
    async recoverTimeouts() {
        try {
            logger.info('Recuperando timeouts do banco de dados...');

            // Buscar eventos não processados que ainda devem executar
            const activeEvents = await database.query(`
                SELECT * FROM events_queue 
                WHERE processed = false 
                AND scheduled_for > NOW()
                AND attempts < max_attempts
            `);

            for (const event of activeEvents.rows) {
                const delay = new Date(event.scheduled_for) - new Date();
                
                if (delay > 0 && delay < 24 * 60 * 60 * 1000) { // Só recupera se for nas próximas 24h
                    if (event.event_type === 'pix_timeout') {
                        // Recriar timeout PIX
                        const timeoutId = setTimeout(async () => {
                            await this.handlePixTimeout(event.order_code, event.conversation_id);
                            this.activeTimeouts.delete(event.order_code);
                        }, delay);
                        
                        this.activeTimeouts.set(event.order_code, timeoutId);
                        
                    } else if (event.event_type === 'final_check') {
                        // Recriar timeout de verificação final
                        const timeoutId = setTimeout(async () => {
                            await this.handleFinalCheck(event.order_code, event.conversation_id);
                            this.activeTimeouts.delete(`final_${event.order_code}`);
                        }, delay);
                        
                        this.activeTimeouts.set(`final_${event.order_code}`, timeoutId);
                    }
                    
                    logger.info(`Timeout recuperado: ${event.event_type} ${event.order_code} em ${Math.round(delay/1000)}s`);
                }
            }

            logger.info(`${activeEvents.rows.length} timeouts recuperados do banco`);

        } catch (error) {
            logger.error(`Erro ao recuperar timeouts: ${error.message}`, error);
        }
    }

    /**
     * Limpar recursos (chamado no shutdown)
     */
    async cleanup() {
        try {
            logger.info('Limpando timeouts ativos...');
            
            // Cancelar todos os timeouts ativos
            for (const [key, timeoutId] of this.activeTimeouts.entries()) {
                clearTimeout(timeoutId);
            }
            
            this.activeTimeouts.clear();
            this.retryAttempts.clear();
            this.isInitialized = false;
            
            logger.info('Cleanup do sistema de filas concluído');
            
        } catch (error) {
            logger.error(`Erro no cleanup: ${error.message}`, error);
        }
    }

    /**
     * Obter estatísticas da fila
     */
    async getQueueStats() {
        try {
            const [pending, processing, failed] = await Promise.all([
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false AND scheduled_for <= NOW()'),
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false AND scheduled_for > NOW()'),
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE attempts >= max_attempts AND processed = false')
            ]);

            return {
                active_timeouts: this.activeTimeouts.size,
                pending_events: parseInt(pending.rows[0].count),
                scheduled_events: parseInt(processing.rows[0].count),
                failed_events: parseInt(failed.rows[0].count)
            };

        } catch (error) {
            logger.error(`Erro ao obter estatísticas da fila: ${error.message}`, error);
            return {
                active_timeouts: this.activeTimeouts.size,
                pending_events: 0,
                scheduled_events: 0,
                failed_events: 0
            };
        }
    }

    /**
     * Utilitários
     */
    getFirstName(fullName) {
        return fullName ? fullName.split(' ')[0].trim() : 'Cliente';
    }

    getBrazilTime() {
        return new Date().toLocaleString('pt-BR', { 
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

// Instância única do serviço
const queueService = new QueueService();

module.exports = queueService;
