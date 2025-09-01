/**
 * SISTEMA DE FILAS E TIMEOUTS - VERSÃO CORRIGIDA
 * Gerencia timeouts de PIX e envios para N8N
 * CORREÇÕES: Removida verificação final de 25min completamente
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

            logger.info(`Timeout PIX agendado: ${orderCode} em ${Math.round(timeoutMs/60000)} minutos`);

        } catch (error) {
            logger.error(`Erro ao agendar timeout PIX ${orderCode}: ${error.message}`, error);
        }
    }

    // REMOVIDA COMPLETAMENTE: addFinalCheck() - não existe mais

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
                timeout_minutos: 7,
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

    // REMOVIDA COMPLETAMENTE: handleFinalCheck() - não existe mais

    /**
     * Enviar dados para N8N com retry automático
     */
    async sendToN8N(eventData, eventType, conversationId, attempt = 1) {
        const maxAttempts = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;
        
        try {
            logger.info(`Enviando para N8N (tentativa ${attempt}): ${eventType} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);

            // Log completo do payload para debug
            logger.debug(`Payload N8N ${eventType}:`, eventData);

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

            logger.info(`N8N enviado com sucesso: ${eventType} | Status: ${response.status} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);
            return true;

        } catch (error) {
            const errorMessage = error.response ? 
                `HTTP ${error.response.status}: ${error.response.statusText}` : 
                error.message;

            logger.error(`Erro ao enviar para N8N (tentativa ${attempt}/${maxAttempts}): ${errorMessage} | Evento: ${eventType}`);

            // Registrar falha
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'n8n_sent', `${eventType}: ERRO - ${errorMessage}`, 'failed']
            );

            // Tentar novamente se não excedeu limite
            if (attempt < maxAttempts) {
                const delay = attempt * 2000; // 2s, 4s, 6s...
                logger.info(`Tentando novamente em ${delay/1000}s... (${attempt + 1}/${maxAttempts})`);
                
                setTimeout(() => {
                    this.sendToN8N(eventData, eventType, conversationId, attempt + 1);
                }, delay);
                
                return false;
            } else {
                logger.error(`Máximo de tentativas excedido para ${eventType} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);
                
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
                logger.info(`Timeout PIX cancelado em memória: ${orderCode}`);
            }

            // Marcar eventos relacionados como processados no banco
            const result = await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND event_type = 'pix_timeout' AND processed = false
            `, [orderCode]);

            if (result.rowCount > 0) {
                logger.info(`${result.rowCount} evento(s) PIX cancelado(s) no banco: ${orderCode}`);
            }

        } catch (error) {
            logger.error(`Erro ao cancelar PIX pendente ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Cancelar todos os timeouts de um pedido
     */
    async cancelAllTimeouts(orderCode) {
        try {
            logger.info(`Cancelando todos os timeouts para: ${orderCode}`);

            // Cancelar timeout principal
            if (this.activeTimeouts.has(orderCode)) {
                clearTimeout(this.activeTimeouts.get(orderCode));
                this.activeTimeouts.delete(orderCode);
                logger.info(`Timeout principal cancelado: ${orderCode}`);
            }

            // REMOVIDO: Cancelar timeout de verificação final (não existe mais)

            // Marcar eventos no banco como processados
            const result = await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND processed = false
            `, [orderCode]);

            if (result.rowCount > 0) {
                logger.info(`${result.rowCount} evento(s) cancelado(s) no banco: ${orderCode}`);
            }

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

            if (pendingEvents.rows.length > 0) {
                logger.info(`Processando ${pendingEvents.rows.length} eventos pendentes da fila`);
            }

            for (const event of pendingEvents.rows) {
                try {
                    logger.info(`Processando evento da fila: ${event.event_type} | ${event.order_code || 'N/A'}`);

                    // Incrementar tentativas
                    await database.query(
                        'UPDATE events_queue SET attempts = attempts + 1, last_attempt = NOW() WHERE id = $1',
                        [event.id]
                    );

                    let processed = false;

                    if (event.event_type === 'pix_timeout') {
                        await this.handlePixTimeout(event.order_code, event.conversation_id);
                        processed = true;
                    } 
                    // REMOVIDO: final_check - não existe mais
                    else if (event.payload) {
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
                        logger.info(`Evento processado com sucesso: ${event.event_type} | ${event.order_code || 'N/A'}`);
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

            let recovered = 0;

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
                        recovered++;
                        
                        logger.info(`Timeout PIX recuperado: ${event.order_code} em ${Math.round(delay/1000)}s`);
                    }
                    // REMOVIDO: final_check - não existe mais
                }
            }

            // Limpar eventos final_check pendentes (conforme solicitado no problema 3)
            const cleanupResult = await database.query(`
                DELETE FROM events_queue 
                WHERE event_type = 'final_check' AND processed = false
            `);

            if (cleanupResult.rowCount > 0) {
                logger.info(`${cleanupResult.rowCount} evento(s) final_check removidos do banco`);
            }

            logger.info(`${recovered} timeout(s) recuperado(s) do banco`);

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

    /**
     * Normalizar número de telefone (consistente com o sistema)
     */
    normalizePhone(phone) {
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
}

// Instância única do serviço
const queueService = new QueueService();

module.exports = queueService;
