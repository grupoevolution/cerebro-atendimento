/**
 * SISTEMA DE FILAS E TIMEOUTS v3.2 - DEFINITIVAMENTE CORRIGIDO
 * Gerencia timeouts de PIX e envios para N8N
 * 
 * CORREÇÕES DEFINITIVAS:
 * ✅ Função addFinalCheck REMOVIDA completamente
 * ✅ Função handleFinalCheck REMOVIDA completamente
 * ✅ Todas as referências a final_check REMOVIDAS
 * ✅ Limpeza automática de eventos final_check antigos
 * ✅ Sistema de retry OTIMIZADO
 * ✅ Logs DEBUG completos para troubleshooting
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
            
            logger.info('🔧 Inicializando sistema de filas v3.2...');
            
            // Limpar eventos final_check imediatamente
            await this.cleanupFinalCheckEvents();
            
            // Processar eventos pendentes na fila a cada 30 segundos
            setInterval(() => {
                this.processQueue();
            }, 30000);
            
            logger.info('✅ Sistema de filas v3.2 inicializado (sem final_check)');
            
        } catch (error) {
            logger.error(`❌ Erro ao inicializar sistema de filas: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * NOVA FUNÇÃO - Limpar eventos final_check antigos
     */
    async cleanupFinalCheckEvents() {
        try {
            logger.info('🧹 Limpando eventos final_check do banco...');
            
            const result = await database.query(`
                DELETE FROM events_queue WHERE event_type = 'final_check'
            `);
            
            if (result.rowCount > 0) {
                logger.info(`✅ ${result.rowCount} evento(s) final_check removidos do banco`);
            } else {
                logger.debug('ℹ️ Nenhum evento final_check encontrado para limpar');
            }
            
        } catch (error) {
            logger.error(`❌ Erro ao limpar eventos final_check: ${error.message}`, error);
        }
    }

    /**
     * Adicionar timeout de PIX (7 minutos) - FUNÇÃO CORRIGIDA
     */
    async addPixTimeout(orderCode, conversationId, timeoutMs) {
        try {
            logger.info(`⏰ Agendando timeout PIX: ${orderCode} em ${Math.round(timeoutMs/60000)} minutos`);
            
            // Cancelar timeout existente se houver
            if (this.activeTimeouts.has(orderCode)) {
                clearTimeout(this.activeTimeouts.get(orderCode));
                this.activeTimeouts.delete(orderCode);
                logger.debug(`🔄 Timeout anterior cancelado para: ${orderCode}`);
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
                JSON.stringify({ 
                    orderCode, 
                    conversationId, 
                    timeoutMs,
                    created_at: new Date().toISOString() 
                })
            ]);

            // Criar timeout em memória
            const timeoutId = setTimeout(async () => {
                logger.info(`⏰ Executando timeout PIX: ${orderCode}`);
                await this.handlePixTimeout(orderCode, conversationId);
                this.activeTimeouts.delete(orderCode);
            }, timeoutMs);

            this.activeTimeouts.set(orderCode, timeoutId);

            logger.info(`✅ Timeout PIX agendado: ${orderCode} | ${Math.round(timeoutMs/60000)} min | ID: ${timeoutId}`);

        } catch (error) {
            logger.error(`❌ Erro ao agendar timeout PIX ${orderCode}: ${error.message}`, error);
        }
    }

    // FUNÇÃO REMOVIDA COMPLETAMENTE: addFinalCheck() - NÃO EXISTE MAIS

    /**
     * Processar timeout de PIX (7 minutos sem pagamento) - FUNÇÃO CORRIGIDA
     */
    async handlePixTimeout(orderCode, conversationId) {
        try {
            logger.info(`⏰ Processando timeout PIX: ${orderCode} | Conversa: ${conversationId}`);

            // Verificar se ainda está pendente (não foi pago enquanto isso)
            const conversation = await database.query(
                'SELECT * FROM conversations WHERE id = $1 AND status = $2',
                [conversationId, 'pix_pending']
            );

            if (conversation.rows.length === 0) {
                logger.info(`ℹ️ PIX ${orderCode} não está mais pendente - timeout cancelado automaticamente`);
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

            logger.debug(`📤 Payload PIX timeout para N8N:`, eventData);

            // Enviar para N8N
            const success = await this.sendToN8N(eventData, 'pix_timeout', conversationId);

            if (success) {
                logger.info(`✅ Timeout PIX enviado com sucesso: ${orderCode}`);
            } else {
                logger.error(`❌ Falha ao enviar timeout PIX: ${orderCode}`);
            }

        } catch (error) {
            logger.error(`❌ Erro ao processar timeout PIX ${orderCode}: ${error.message}`, error);
        }
    }

    // FUNÇÃO REMOVIDA COMPLETAMENTE: handleFinalCheck() - NÃO EXISTE MAIS

    /**
     * Enviar dados para N8N com retry automático OTIMIZADO
     */
    async sendToN8N(eventData, eventType, conversationId, attempt = 1) {
        const maxAttempts = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;
        
        try {
            logger.info(`📤 Enviando para N8N (tentativa ${attempt}/${maxAttempts}): ${eventType} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);

            // Log payload completo para debug
            logger.debug(`📦 Payload N8N completo:`, {
                event_type: eventData.event_type,
                produto: eventData.produto,
                cliente_telefone: eventData.cliente?.telefone,
                pedido_codigo: eventData.pedido?.codigo,
                payload_size: JSON.stringify(eventData).length
            });

            const response = await axios.post(process.env.N8N_WEBHOOK_URL, eventData, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Cerebro-Evolution-v3.2/1.0'
                },
                timeout: 15000
            });

            // Registrar sucesso no banco
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'n8n_sent', `${eventType}: HTTP ${response.status}`, 'delivered']
            );

            logger.info(`✅ N8N enviado com sucesso: ${eventType} | Status: ${response.status} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);
            return true;

        } catch (error) {
            const errorMessage = error.response ? 
                `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}` : 
                error.message;

            logger.error(`❌ Erro N8N (tentativa ${attempt}/${maxAttempts}): ${errorMessage} | Evento: ${eventType} | Pedido: ${eventData.pedido?.codigo}`);

            // Registrar falha no banco
            await database.query(
                'INSERT INTO messages (conversation_id, type, content, status) VALUES ($1, $2, $3, $4)',
                [conversationId, 'n8n_sent', `${eventType}: ERRO ${error.response?.status || 'TIMEOUT'} - ${errorMessage}`, 'failed']
            );

            // Tentar novamente se não excedeu limite
            if (attempt < maxAttempts) {
                const delay = attempt * 2000; // 2s, 4s, 6s...
                logger.info(`🔄 Retry em ${delay/1000}s... (${attempt + 1}/${maxAttempts}) | ${eventType}`);
                
                return new Promise((resolve) => {
                    setTimeout(async () => {
                        const result = await this.sendToN8N(eventData, eventType, conversationId, attempt + 1);
                        resolve(result);
                    }, delay);
                });
                
            } else {
                logger.error(`🚨 Máximo de tentativas excedido: ${eventType} | Pedido: ${eventData.pedido?.codigo || 'N/A'}`);
                
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
     * Cancelar PIX pendente (quando venda é aprovada) - FUNÇÃO CORRIGIDA
     */
    async cancelPendingPix(orderCode) {
        try {
            logger.info(`🚫 Cancelando PIX pendente: ${orderCode}`);
            
            // Cancelar timeout em memória
            if (this.activeTimeouts.has(orderCode)) {
                const timeoutId = this.activeTimeouts.get(orderCode);
                clearTimeout(timeoutId);
                this.activeTimeouts.delete(orderCode);
                logger.info(`✅ Timeout PIX cancelado em memória: ${orderCode} | ID: ${timeoutId}`);
            } else {
                logger.debug(`ℹ️ Nenhum timeout ativo em memória para: ${orderCode}`);
            }

            // Marcar eventos relacionados como processados no banco
            const result = await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND event_type = 'pix_timeout' AND processed = false
            `, [orderCode]);

            if (result.rowCount > 0) {
                logger.info(`✅ ${result.rowCount} evento(s) PIX cancelado(s) no banco: ${orderCode}`);
            } else {
                logger.debug(`ℹ️ Nenhum evento PIX pendente no banco para: ${orderCode}`);
            }

        } catch (error) {
            logger.error(`❌ Erro ao cancelar PIX pendente ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Cancelar todos os timeouts de um pedido - FUNÇÃO MEGA CORRIGIDA
     */
    async cancelAllTimeouts(orderCode) {
        try {
            logger.info(`🚫 Cancelando TODOS os timeouts para: ${orderCode}`);

            // 1. Cancelar timeout principal (PIX) em memória
            if (this.activeTimeouts.has(orderCode)) {
                const timeoutId = this.activeTimeouts.get(orderCode);
                clearTimeout(timeoutId);
                this.activeTimeouts.delete(orderCode);
                logger.info(`✅ Timeout principal cancelado: ${orderCode} | ID: ${timeoutId}`);
            }

            // 2. REMOVIDO: Cancelamento de timeout final_check - NÃO EXISTE MAIS

            // 3. Marcar TODOS os eventos pendentes como processados no banco
            const result = await database.query(`
                UPDATE events_queue 
                SET processed = true, last_attempt = NOW() 
                WHERE order_code = $1 AND processed = false
            `, [orderCode]);

            if (result.rowCount > 0) {
                logger.info(`✅ ${result.rowCount} evento(s) cancelado(s) no banco: ${orderCode}`);
            } else {
                logger.debug(`ℹ️ Nenhum evento pendente no banco para: ${orderCode}`);
            }

            logger.info(`✅ Cancelamento completo executado: ${orderCode}`);

        } catch (error) {
            logger.error(`❌ Erro ao cancelar timeouts ${orderCode}: ${error.message}`, error);
        }
    }

    /**
     * Processar fila de eventos pendentes - FUNÇÃO CORRIGIDA
     */
    async processQueue() {
        try {
            // Buscar apenas eventos de PIX timeout (final_check não existe mais)
            const pendingEvents = await database.query(`
                SELECT * FROM events_queue 
                WHERE processed = false 
                AND scheduled_for <= NOW() 
                AND attempts < max_attempts
                AND event_type != 'final_check'
                ORDER BY created_at ASC
                LIMIT 10
            `);

            if (pendingEvents.rows.length > 0) {
                logger.info(`📋 Processando ${pendingEvents.rows.length} eventos pendentes da fila`);
            }

            for (const event of pendingEvents.rows) {
                try {
                    logger.info(`🔧 Processando evento: ${event.event_type} | ${event.order_code || 'N/A'} | ID: ${event.id}`);

                    // Incrementar tentativas
                    await database.query(
                        'UPDATE events_queue SET attempts = attempts + 1, last_attempt = NOW() WHERE id = $1',
                        [event.id]
                    );

                    let processed = false;

                    if (event.event_type === 'pix_timeout') {
                        await this.handlePixTimeout(event.order_code, event.conversation_id);
                        processed = true;
                        
                    } else if (event.payload) {
                        // Tentar reenviar evento que falhou anteriormente
                        try {
                            const payload = JSON.parse(event.payload);
                            processed = await this.sendToN8N(payload, event.event_type, event.conversation_id);
                        } catch (parseError) {
                            logger.error(`❌ Erro ao parsear payload do evento ${event.id}: ${parseError.message}`);
                            processed = false;
                        }
                    }

                    // Marcar como processado se bem-sucedido
                    if (processed) {
                        await database.query(
                            'UPDATE events_queue SET processed = true WHERE id = $1',
                            [event.id]
                        );
                        logger.info(`✅ Evento processado com sucesso: ${event.event_type} | ${event.order_code || 'N/A'}`);
                    } else {
                        logger.warn(`⚠️ Evento não processado: ${event.event_type} | ${event.order_code || 'N/A'}`);
                    }

                } catch (error) {
                    logger.error(`❌ Erro ao processar evento ${event.id}: ${error.message}`, error);
                }
            }

        } catch (error) {
            logger.error(`❌ Erro ao processar fila: ${error.message}`, error);
        }
    }

    /**
     * Recuperar timeouts do banco (após restart) - FUNÇÃO CORRIGIDA
     */
    async recoverTimeouts() {
        try {
            logger.info('🔄 Recuperando timeouts do banco de dados...');

            // PRIMEIRO: Limpar eventos final_check restantes
            await this.cleanupFinalCheckEvents();

            // Buscar apenas eventos PIX não processados
            const activeEvents = await database.query(`
                SELECT * FROM events_queue 
                WHERE processed = false 
                AND scheduled_for > NOW()
                AND attempts < max_attempts
                AND event_type = 'pix_timeout'
            `);

            let recovered = 0;

            for (const event of activeEvents.rows) {
                const delay = new Date(event.scheduled_for) - new Date();
                
                // Só recuperar se for nas próximas 24h e for timeout PIX
                if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
                    // Recriar timeout PIX
                    const timeoutId = setTimeout(async () => {
                        logger.info(`⏰ Executando timeout PIX recuperado: ${event.order_code}`);
                        await this.handlePixTimeout(event.order_code, event.conversation_id);
                        this.activeTimeouts.delete(event.order_code);
                    }, delay);
                    
                    this.activeTimeouts.set(event.order_code, timeoutId);
                    recovered++;
                    
                    logger.info(`✅ Timeout PIX recuperado: ${event.order_code} em ${Math.round(delay/1000)}s | ID: ${timeoutId}`);
                }
                // REMOVIDO: Recuperação de final_check - não existe mais
            }

            logger.info(`✅ ${recovered} timeout(s) PIX recuperado(s) do banco`);

        } catch (error) {
            logger.error(`❌ Erro ao recuperar timeouts: ${error.message}`, error);
        }
    }

    /**
     * Limpar recursos (chamado no shutdown) - FUNÇÃO CORRIGIDA
     */
    async cleanup() {
        try {
            logger.info('🧹 Limpando timeouts ativos...');
            
            // Cancelar todos os timeouts ativos
            for (const [orderCode, timeoutId] of this.activeTimeouts.entries()) {
                clearTimeout(timeoutId);
                logger.debug(`🚫 Timeout cancelado: ${orderCode} | ID: ${timeoutId}`);
            }
            
            this.activeTimeouts.clear();
            this.retryAttempts.clear();
            this.isInitialized = false;
            
            logger.info('✅ Cleanup do sistema de filas concluído');
            
        } catch (error) {
            logger.error(`❌ Erro no cleanup: ${error.message}`, error);
        }
    }

    /**
     * Obter estatísticas da fila - FUNÇÃO CORRIGIDA
     */
    async getQueueStats() {
        try {
            const [pending, processing, failed, pixTimeouts] = await Promise.all([
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false AND scheduled_for <= NOW()'),
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false AND scheduled_for > NOW()'),
                database.query('SELECT COUNT(*) as count FROM events_queue WHERE attempts >= max_attempts AND processed = false'),
                database.query("SELECT COUNT(*) as count FROM events_queue WHERE event_type = 'pix_timeout' AND processed = false")
            ]);

            const stats = {
                active_timeouts: this.activeTimeouts.size,
                pending_events: parseInt(pending.rows[0].count),
                scheduled_events: parseInt(processing.rows[0].count),
                failed_events: parseInt(failed.rows[0].count),
                pix_timeouts: parseInt(pixTimeouts.rows[0].count)
            };

            logger.debug('📊 Estatísticas da fila:', stats);
            return stats;

        } catch (error) {
            logger.error(`❌ Erro ao obter estatísticas da fila: ${error.message}`, error);
            return {
                active_timeouts: this.activeTimeouts.size,
                pending_events: 0,
                scheduled_events: 0,
                failed_events: 0,
                pix_timeouts: 0
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Obter detalhes dos timeouts ativos
     */
    getActiveTimeoutsDetails() {
        const details = [];
        
        for (const [orderCode, timeoutId] of this.activeTimeouts.entries()) {
            details.push({
                order_code: orderCode,
                timeout_id: timeoutId,
                type: 'pix_timeout'
            });
        }
        
        logger.debug(`📋 Timeouts ativos em memória: ${details.length}`);
        return details;
    }

    /**
     * NOVA FUNÇÃO - Forçar processamento da fila
     */
    async forceProcessQueue() {
        logger.info('🔄 Forçando processamento da fila...');
        await this.processQueue();
        return await this.getQueueStats();
    }

    /**
     * NOVA FUNÇÃO - Cancelar evento específico
     */
    async cancelEvent(eventId) {
        try {
            logger.info(`🚫 Cancelando evento específico: ${eventId}`);
            
            const result = await database.query(
                'UPDATE events_queue SET processed = true, last_attempt = NOW() WHERE id = $1',
                [eventId]
            );
            
            if (result.rowCount > 0) {
                logger.info(`✅ Evento ${eventId} cancelado no banco`);
                return true;
            } else {
                logger.warn(`⚠️ Evento ${eventId} não encontrado`);
                return false;
            }
            
        } catch (error) {
            logger.error(`❌ Erro ao cancelar evento ${eventId}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * NOVA FUNÇÃO - Reprocessar evento falhado
     */
    async retryFailedEvent(eventId) {
        try {
            logger.info(`🔄 Reprocessando evento falhado: ${eventId}`);
            
            const event = await database.query(
                'SELECT * FROM events_queue WHERE id = $1',
                [eventId]
            );
            
            if (event.rows.length === 0) {
                logger.warn(`⚠️ Evento ${eventId} não encontrado para retry`);
                return false;
            }
            
            const eventData = event.rows[0];
            
            // Reset attempts
            await database.query(
                'UPDATE events_queue SET attempts = 0, processed = false WHERE id = $1',
                [eventId]
            );
            
            // Tentar processar novamente
            let success = false;
            
            if (eventData.event_type === 'pix_timeout') {
                await this.handlePixTimeout(eventData.order_code, eventData.conversation_id);
                success = true;
            } else if (eventData.payload) {
                const payload = JSON.parse(eventData.payload);
                success = await this.sendToN8N(payload, eventData.event_type, eventData.conversation_id);
            }
            
            if (success) {
                await database.query(
                    'UPDATE events_queue SET processed = true WHERE id = $1',
                    [eventId]
                );
                logger.info(`✅ Evento ${eventId} reprocessado com sucesso`);
            }
            
            return success;
            
        } catch (error) {
            logger.error(`❌ Erro ao reprocessar evento ${eventId}: ${error.message}`, error);
            return false;
        }
    }

    /**
     * UTILITÁRIOS
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
        
        logger.debug(`🔧 Normalizando telefone: "${phone}"`);
        
        // Remover caracteres não numéricos
        let cleanPhone = phone.replace(/\D/g, '');
        
        // Padronizar para formato: 5511999999999 (sem o 9 extra)
        if (cleanPhone.length === 14 && cleanPhone.substring(4, 5) === '9') {
            cleanPhone = cleanPhone.substring(0, 4) + cleanPhone.substring(5);
        }
        
        logger.debug(`✅ Telefone normalizado: ${phone} → ${cleanPhone}`);
        return cleanPhone;
    }

    /**
     * NOVA FUNÇÃO - Verificar saúde do sistema de filas
     */
    async healthCheck() {
        try {
            const stats = await this.getQueueStats();
            const activeTimeoutsDetails = this.getActiveTimeoutsDetails();
            
            const health = {
                status: this.isInitialized ? 'healthy' : 'not_initialized',
                active_timeouts_memory: this.activeTimeouts.size,
                active_timeouts_details: activeTimeoutsDetails,
                queue_stats: stats,
                issues: []
            };
            
            // Verificar possíveis problemas
            if (stats.failed_events > 10) {
                health.issues.push(`Muitos eventos falhados: ${stats.failed_events}`);
            }
            
            if (stats.pending_events > 50) {
                health.issues.push(`Muitos eventos pendentes: ${stats.pending_events}`);
            }
            
            if (this.activeTimeouts.size !== stats.pix_timeouts) {
                health.issues.push(`Divergência entre memória (${this.activeTimeouts.size}) e banco (${stats.pix_timeouts})`);
            }
            
            health.overall_status = health.issues.length === 0 ? 'healthy' : 'warning';
            
            return health;
            
        } catch (error) {
            logger.error(`❌ Erro no health check da fila: ${error.message}`, error);
            return {
                status: 'error',
                error: error.message,
                overall_status: 'error'
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Limpar fila de eventos antigos
     */
    async cleanupOldEvents() {
        try {
            logger.info('🧹 Limpando eventos antigos da fila...');
            
            // Remover eventos processados há mais de 7 dias
            const processedResult = await database.query(`
                DELETE FROM events_queue 
                WHERE processed = true AND created_at < NOW() - INTERVAL '7 days'
            `);
            
            // Remover eventos final_check (independente da data)
            const finalCheckResult = await database.query(`
                DELETE FROM events_queue WHERE event_type = 'final_check'
            `);
            
            // Remover eventos que falharam há mais de 30 dias
            const failedResult = await database.query(`
                DELETE FROM events_queue 
                WHERE attempts >= max_attempts AND created_at < NOW() - INTERVAL '30 days'
            `);
            
            const totalCleaned = processedResult.rowCount + finalCheckResult.rowCount + failedResult.rowCount;
            
            logger.info(`✅ Limpeza da fila concluída: ${totalCleaned} evento(s) removido(s)`, {
                processed_old: processedResult.rowCount,
                final_check_removed: finalCheckResult.rowCount,
                failed_old: failedResult.rowCount
            });
            
            return {
                total_cleaned: totalCleaned,
                processed_old: processedResult.rowCount,
                final_check_removed: finalCheckResult.rowCount,
                failed_old: failedResult.rowCount
            };
            
        } catch (error) {
            logger.error(`❌ Erro na limpeza da fila: ${error.message}`, error);
            return {
                total_cleaned: 0,
                error: error.message
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Obter eventos falhados para reprocessamento
     */
    async getFailedEvents(limit = 20) {
        try {
            const failedEvents = await database.query(`
                SELECT eq.*, c.order_code, c.client_name, c.phone
                FROM events_queue eq
                LEFT JOIN conversations c ON eq.conversation_id = c.id
                WHERE eq.attempts >= eq.max_attempts 
                AND eq.processed = false
                AND eq.event_type != 'final_check'
                ORDER BY eq.created_at DESC
                LIMIT $1
            `, [limit]);

            return failedEvents.rows.map(event => ({
                ...event,
                payload: event.payload ? JSON.parse(event.payload) : null,
                created_brazil: new Date(event.created_at).toLocaleString('pt-BR', { 
                    timeZone: 'America/Sao_Paulo' 
                })
            }));

        } catch (error) {
            logger.error(`❌ Erro ao obter eventos falhados: ${error.message}`, error);
            return [];
        }
    }
}

// Instância única do serviço
const queueService = new QueueService();

module.exports = queueService;
