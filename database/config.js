/**
 * CONFIGURAÇÃO DO BANCO DE DADOS POSTGRESQL v3.2 - MEGA CORRIGIDA
 * Módulo responsável pela conexão e operações com PostgreSQL
 * 
 * CORREÇÕES DEFINITIVAS:
 * ✅ Remoção completa de final_check das migrações
 * ✅ Normalização automática de telefones
 * ✅ Constraint que impede criação de final_check
 * ✅ Limpeza automática de eventos antigos
 * ✅ Estatísticas detalhadas e métricas de qualidade
 * ✅ Functions de manutenção automatizada
 */

const { Pool } = require('pg');
const logger = require('../services/logger');

class Database {
    constructor() {
        this.pool = null;
        this.connected = false;
        this.version = '3.2-MEGA-CORRECTED';
    }

    /**
     * Conectar ao PostgreSQL
     */
    async connect() {
        try {
            logger.info('🔌 Conectando ao PostgreSQL...');
            
            // Configuração da conexão
            const config = {
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 20, // máximo de conexões no pool
                idleTimeoutMillis: 30000, // tempo limite para conexões ociosas
                connectionTimeoutMillis: 5000, // tempo limite para nova conexão
            };

            // Caso DATABASE_URL não esteja disponível, usar variáveis individuais
            if (!process.env.DATABASE_URL) {
                config.host = process.env.DB_HOST || 'localhost';
                config.port = parseInt(process.env.DB_PORT) || 5432;
                config.user = process.env.DB_USER;
                config.password = process.env.DB_PASSWORD;
                config.database = process.env.DB_NAME;
                delete config.connectionString;
            }

            this.pool = new Pool(config);

            // Testar conexão
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
            client.release();

            this.connected = true;
            logger.info(`✅ Conexão PostgreSQL estabelecida`);
            logger.info(`📅 Data/Hora servidor: ${result.rows[0].current_time}`);
            logger.info(`📊 Versão PostgreSQL: ${result.rows[0].pg_version.split(',')[0]}`);

            // Configurar eventos do pool
            this.pool.on('error', (err) => {
                logger.error('❌ Erro no pool PostgreSQL:', err);
                this.connected = false;
            });

            this.pool.on('connect', () => {
                logger.debug('🔗 Nova conexão PostgreSQL estabelecida');
            });

        } catch (error) {
            logger.error(`❌ Erro ao conectar PostgreSQL: ${error.message}`, error);
            this.connected = false;
            throw error;
        }
    }

    /**
     * Desconectar do banco
     */
    async disconnect() {
        try {
            if (this.pool) {
                await this.pool.end();
                this.connected = false;
                logger.info('✅ Conexão PostgreSQL encerrada');
            }
        } catch (error) {
            logger.error(`❌ Erro ao desconectar PostgreSQL: ${error.message}`, error);
        }
    }

    /**
     * Executar query com logs otimizados
     */
    async query(text, params = []) {
        if (!this.connected || !this.pool) {
            throw new Error('Banco de dados não conectado');
        }

        try {
            const start = Date.now();
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;

            // Log apenas queries lentas (>1s) ou com muitos resultados
            if (duration > 1000) {
                logger.warn(`🐌 Query lenta (${duration}ms): ${text.substring(0, 100)}...`);
            } else if (duration > 500) {
                logger.debug(`⏰ Query moderada (${duration}ms): ${text.substring(0, 50)}...`);
            }

            return result;
        } catch (error) {
            logger.error(`❌ Erro na query: ${error.message}`, { 
                query: text.substring(0, 200),
                params: params 
            });
            throw error;
        }
    }

    /**
     * Executar transação
     */
    async transaction(queries) {
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const results = [];
            for (const { text, params } of queries) {
                const result = await client.query(text, params);
                results.push(result);
            }
            
            await client.query('COMMIT');
            return results;
            
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`❌ Erro na transação: ${error.message}`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Verificar se está conectado
     */
    isConnected() {
        return this.connected && this.pool;
    }

    /**
     * EXECUTAR MIGRAÇÕES CORRIGIDAS v3.2
     */
    async migrate() {
        try {
            logger.info('🔧 Executando migrações do banco de dados v3.2...');

            // PRIMEIRO: Limpar eventos final_check se existirem
            await this.cleanupFinalCheckEvents();

            // Criar tabela de leads com campos melhorados
            await this.query(`
                CREATE TABLE IF NOT EXISTS leads (
                    phone VARCHAR(20) PRIMARY KEY,
                    instance_name VARCHAR(10) NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    first_contact_date DATE DEFAULT CURRENT_DATE,
                    total_conversations INTEGER DEFAULT 0,
                    last_conversation_date TIMESTAMP
                );
            `);

            // Criar tabela de conversas com novos campos
            await this.query(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id SERIAL PRIMARY KEY,
                    phone VARCHAR(20) NOT NULL,
                    order_code VARCHAR(50) UNIQUE NOT NULL,
                    product VARCHAR(10),
                    status VARCHAR(20) DEFAULT 'pix_pending',
                    current_step INTEGER DEFAULT 0,
                    responses_count INTEGER DEFAULT 0,
                    instance_name VARCHAR(10),
                    amount DECIMAL(10,2) DEFAULT 0,
                    pix_url TEXT,
                    client_name VARCHAR(255),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    last_response_at TIMESTAMP,
                    conversion_response INTEGER,
                    phone_normalized VARCHAR(20),
                    
                    CONSTRAINT valid_status CHECK (status IN ('pix_pending', 'approved', 'completed', 'timeout', 'convertido')),
                    CONSTRAINT valid_product CHECK (product IN ('FAB', 'NAT', 'CS', 'UNKNOWN'))
                );
            `);

            // Criar tabela de mensagens com controle de duplicatas
            await this.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                    type VARCHAR(20) NOT NULL,
                    content TEXT,
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW(),
                    response_number INTEGER,
                    is_duplicate BOOLEAN DEFAULT FALSE,
                    processed_at TIMESTAMP,
                    
                    CONSTRAINT valid_type CHECK (type IN ('sent', 'received', 'system_event', 'n8n_sent')),
                    CONSTRAINT valid_status CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'duplicate', 'ignored'))
                );
            `);

            // Criar tabela de eventos SEM suporte a final_check
            await this.query(`
                CREATE TABLE IF NOT EXISTS events_queue (
                    id SERIAL PRIMARY KEY,
                    event_type VARCHAR(50) NOT NULL,
                    order_code VARCHAR(50),
                    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                    payload JSONB,
                    scheduled_for TIMESTAMP,
                    processed BOOLEAN DEFAULT FALSE,
                    attempts INTEGER DEFAULT 0,
                    max_attempts INTEGER DEFAULT 3,
                    last_attempt TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(),
                    error_message TEXT,
                    processing_started_at TIMESTAMP,
                    processed_at TIMESTAMP,
                    
                    CONSTRAINT valid_event_type CHECK (event_type != 'final_check'),
                    CONSTRAINT event_type_allowed CHECK (event_type IN ('pix_timeout', 'venda_aprovada', 'resposta_01', 'resposta_02', 'resposta_03', 'convertido'))
                );
            `);

            // Criar tabela de logs melhorada
            await this.query(`
                CREATE TABLE IF NOT EXISTS system_logs (
                    id SERIAL PRIMARY KEY,
                    level VARCHAR(10) NOT NULL,
                    message TEXT NOT NULL,
                    meta JSONB,
                    created_at TIMESTAMP DEFAULT NOW(),
                    brazil_time VARCHAR(50),
                    process_id INTEGER,
                    source VARCHAR(50),
                    
                    CONSTRAINT valid_level CHECK (level IN ('error', 'warn', 'info', 'debug'))
                );
            `);

            // Criar índices otimizados
            await this.createOptimizedIndexes();

            // Criar funções e triggers
            await this.createFunctionsAndTriggers();

            // Adicionar colunas se não existirem (migrações antigas)
            await this.addMissingColumns();

            // Limpar dados antigos
            await this.query(`DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '7 days';`);

            // Executar normalização de telefones existentes
            await this.normalizeExistingPhones();

            logger.info('✅ Migrações v3.2 executadas com sucesso');

        } catch (error) {
            logger.error(`❌ Erro ao executar migrações: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * NOVA FUNÇÃO - Limpar eventos final_check
     */
    async cleanupFinalCheckEvents() {
        try {
            logger.info('🧹 Limpando eventos final_check do banco...');
            
            const result = await this.query(`DELETE FROM events_queue WHERE event_type = 'final_check'`);
            
            if (result.rowCount > 0) {
                logger.info(`✅ ${result.rowCount} evento(s) final_check removidos`);
            } else {
                logger.debug('ℹ️ Nenhum evento final_check encontrado');
            }
            
        } catch (error) {
            // Pode falhar se tabela não existir ainda, ignorar
            logger.debug('Info: Tabela events_queue pode não existir ainda');
        }
    }

    /**
     * Criar índices otimizados
     */
    async createOptimizedIndexes() {
        try {
            logger.info('🔧 Criando índices otimizados...');
            
            const indexes = [
                // Leads
                'CREATE INDEX IF NOT EXISTS idx_leads_instance ON leads(instance_name)',
                'CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at)',
                'CREATE INDEX IF NOT EXISTS idx_leads_last_conversation ON leads(last_conversation_date)',
                
                // Conversations
                'CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_phone_normalized ON conversations(phone_normalized)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_order_code ON conversations(order_code)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_instance ON conversations(instance_name)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)',
                'CREATE INDEX IF NOT EXISTS idx_conversations_status_active ON conversations(status) WHERE status IN (\'pix_pending\', \'approved\')',
                
                // Messages
                'CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)',
                'CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type)',
                'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)',
                'CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)',
                'CREATE INDEX IF NOT EXISTS idx_messages_response_number ON messages(response_number)',
                'CREATE INDEX IF NOT EXISTS idx_messages_type_status ON messages(type, status)',
                
                // Events queue
                'CREATE INDEX IF NOT EXISTS idx_events_queue_processed ON events_queue(processed)',
                'CREATE INDEX IF NOT EXISTS idx_events_queue_scheduled ON events_queue(scheduled_for)',
                'CREATE INDEX IF NOT EXISTS idx_events_queue_event_type ON events_queue(event_type)',
                'CREATE INDEX IF NOT EXISTS idx_events_queue_order_code ON events_queue(order_code)',
                'CREATE INDEX IF NOT EXISTS idx_events_queue_pending ON events_queue(processed, scheduled_for) WHERE processed = false',
                'CREATE INDEX IF NOT EXISTS idx_events_queue_failed ON events_queue(attempts, max_attempts) WHERE attempts >= max_attempts',
                
                // System logs
                'CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level)',
                'CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at)',
                'CREATE INDEX IF NOT EXISTS idx_system_logs_source ON system_logs(source)',
                'CREATE INDEX IF NOT EXISTS idx_system_logs_level_created ON system_logs(level, created_at)'
            ];
            
            for (const indexQuery of indexes) {
                await this.query(indexQuery);
            }
            
            logger.info('✅ Índices criados/verificados');
            
        } catch (error) {
            logger.error(`❌ Erro ao criar índices: ${error.message}`, error);
        }
    }

    /**
     * Criar funções e triggers
     */
    async createFunctionsAndTriggers() {
        try {
            logger.info('🔧 Criando funções e triggers...');
            
            // Função para atualizar updated_at
            await this.query(`
                CREATE OR REPLACE FUNCTION update_updated_at_column()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.updated_at = NOW();
                    RETURN NEW;
                END;
                $$ language 'plpgsql';
            `);

            // Função para normalizar telefone
            await this.query(`
                CREATE OR REPLACE FUNCTION normalize_phone_trigger()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.phone_normalized = regexp_replace(NEW.phone, '\\D', '', 'g');
                    
                    IF length(NEW.phone_normalized) = 14 AND substring(NEW.phone_normalized, 1, 2) = '55' THEN
                        IF substring(NEW.phone_normalized, 5, 1) = '9' AND substring(NEW.phone_normalized, 6, 1) != '9' THEN
                            NEW.phone_normalized = substring(NEW.phone_normalized, 1, 4) || substring(NEW.phone_normalized, 6);
                        END IF;
                    END IF;
                    
                    RETURN NEW;
                END;
                $$ language 'plpgsql';
            `);

            // Triggers para updated_at
            await this.query(`
                DROP TRIGGER IF EXISTS update_leads_updated_at ON leads;
                CREATE TRIGGER update_leads_updated_at 
                    BEFORE UPDATE ON leads 
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            `);

            await this.query(`
                DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
                CREATE TRIGGER update_conversations_updated_at 
                    BEFORE UPDATE ON conversations 
                    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
            `);

            // Trigger para normalização automática
            await this.query(`
                DROP TRIGGER IF EXISTS normalize_conversation_phone ON conversations;
                CREATE TRIGGER normalize_conversation_phone 
                    BEFORE INSERT OR UPDATE ON conversations 
                    FOR EACH ROW EXECUTE FUNCTION normalize_phone_trigger();
            `);

            logger.info('✅ Funções e triggers criados');
            
        } catch (error) {
            logger.error(`❌ Erro ao criar funções: ${error.message}`, error);
        }
    }

    /**
     * Adicionar colunas que podem estar faltando
     */
    async addMissingColumns() {
        try {
            const columnsToAdd = [
                'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS client_name VARCHAR(255)',
                'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_response_at TIMESTAMP',
                'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversion_response INTEGER',
                'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20)',
                'ALTER TABLE messages ADD COLUMN IF NOT EXISTS response_number INTEGER',
                'ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_duplicate BOOLEAN DEFAULT FALSE',
                'ALTER TABLE messages ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP',
                'ALTER TABLE events_queue ADD COLUMN IF NOT EXISTS error_message TEXT',
                'ALTER TABLE events_queue ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP',
                'ALTER TABLE events_queue ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP',
                'ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS brazil_time VARCHAR(50)',
                'ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS process_id INTEGER',
                'ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS source VARCHAR(50)',
                'ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_contact_date DATE DEFAULT CURRENT_DATE',
                'ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_conversations INTEGER DEFAULT 0',
                'ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_conversation_date TIMESTAMP'
            ];
            
            for (const columnQuery of columnsToAdd) {
                try {
                    await this.query(columnQuery);
                } catch (error) {
                    // Ignora erro se coluna já existir
                }
            }
            
        } catch (error) {
            logger.debug('Info: Algumas colunas podem já existir');
        }
    }

    /**
     * NOVA FUNÇÃO - Normalizar telefones existentes
     */
    async normalizeExistingPhones() {
        try {
            logger.info('📞 Normalizando telefones existentes...');
            
            // Normalizar na tabela conversations
            const convResult = await this.query(`
                UPDATE conversations SET 
                    phone_normalized = CASE
                        WHEN length(regexp_replace(phone, '\\D', '', 'g')) = 14 
                             AND substring(regexp_replace(phone, '\\D', '', 'g'), 1, 2) = '55'
                             AND substring(regexp_replace(phone, '\\D', '', 'g'), 5, 1) = '9'
                             AND substring(regexp_replace(phone, '\\D', '', 'g'), 6, 1) != '9'
                        THEN substring(regexp_replace(phone, '\\D', '', 'g'), 1, 4) || substring(regexp_replace(phone, '\\D', '', 'g'), 6)
                        ELSE regexp_replace(phone, '\\D', '', 'g')
                    END
                WHERE phone_normalized IS NULL OR phone_normalized = ''
            `);
            
            if (convResult.rowCount > 0) {
                logger.info(`✅ ${convResult.rowCount} telefone(s) normalizados em conversations`);
            }
            
        } catch (error) {
            logger.debug('Info: Normalização pode falhar se colunas não existirem ainda');
        }
    }

    /**
     * Limpar dados antigos CORRIGIDA (sem final_check)
     */
    async cleanup() {
        try {
            const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 dias

            // Limpar conversas antigas completadas
            const deletedConversations = await this.query(`
                DELETE FROM conversations 
                WHERE status IN ('completed', 'timeout', 'convertido') AND updated_at < $1
                RETURNING id;
            `, [cutoffDate]);

            // Limpar eventos processados antigos (EXCETO final_check que não deve existir)
            const deletedEvents = await this.query(`
                DELETE FROM events_queue 
                WHERE processed = true AND created_at < $1
                RETURNING id;
            `, [cutoffDate]);

            // IMPORTANTE: Limpar TODOS os eventos final_check independente da data
            const deletedFinalCheck = await this.query(`
                DELETE FROM events_queue 
                WHERE event_type = 'final_check'
                RETURNING id;
            `);

            // Limpar logs antigos
            const deletedLogs = await this.query(`
                DELETE FROM system_logs 
                WHERE created_at < $1
                RETURNING id;
            `, [cutoffDate]);

            logger.info(`🧹 Limpeza executada: ${deletedConversations.rowCount} conversas, ${deletedEvents.rowCount} eventos, ${deletedFinalCheck.rowCount} final_check, ${deletedLogs.rowCount} logs removidos`);

        } catch (error) {
            logger.error(`❌ Erro na limpeza do banco: ${error.message}`, error);
        }
    }

    /**
     * Obter estatísticas COMPLETAS do banco
     */
    async getStats() {
        try {
            const [
                totalLeads,
                activeConversations,
                pendingPix,
                approvedSales,
                convertedSales,
                timeoutSales,
                totalMessages,
                queuedEvents,
                failedEvents,
                duplicateMessages
            ] = await Promise.all([
                this.query('SELECT COUNT(*) as count FROM leads'),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status IN ('pix_pending', 'approved')"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'pix_pending'"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status IN ('approved', 'completed')"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'convertido'"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'timeout'"),
                this.query('SELECT COUNT(*) as count FROM messages'),
                this.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false'),
                this.query('SELECT COUNT(*) as count FROM events_queue WHERE attempts >= max_attempts AND processed = false'),
                this.query("SELECT COUNT(*) as count FROM messages WHERE status = 'duplicate'")
            ]);

            // Estatísticas por instância
            const instanceStats = await this.query(`
                SELECT 
                    l.instance_name,
                    COUNT(*) as total_leads,
                    COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '24 hours') as leads_last_24h,
                    COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '7 days') as leads_last_7d,
                    COUNT(c.id) as total_conversations,
                    COUNT(c.id) FILTER (WHERE c.status = 'approved') as approved_conversations,
                    COUNT(c.id) FILTER (WHERE c.status = 'convertido') as converted_conversations,
                    COALESCE(SUM(c.amount), 0) as total_revenue
                FROM leads l
                LEFT JOIN conversations c ON l.phone = c.phone
                GROUP BY l.instance_name
                ORDER BY total_leads DESC
            `);

            // Verificar se há eventos final_check (deve ser 0)
            const finalCheckEvents = await this.query("SELECT COUNT(*) as count FROM events_queue WHERE event_type = 'final_check'");

            return {
                // Métricas básicas
                total_leads: parseInt(totalLeads.rows[0].count),
                active_conversations: parseInt(activeConversations.rows[0].count),
                pending_pix: parseInt(pendingPix.rows[0].count),
                approved_sales: parseInt(approvedSales.rows[0].count),
                converted_sales: parseInt(convertedSales.rows[0].count),
                timeout_sales: parseInt(timeoutSales.rows[0].count),
                total_messages: parseInt(totalMessages.rows[0].count),
                queued_events: parseInt(queuedEvents.rows[0].count),
                failed_events: parseInt(failedEvents.rows[0].count),
                duplicate_messages: parseInt(duplicateMessages.rows[0].count),
                
                // Métricas de qualidade
                success_rate: activeConversations.rows[0].count > 0 ? 
                    ((parseInt(approvedSales.rows[0].count) + parseInt(convertedSales.rows[0].count)) / 
                     parseInt(activeConversations.rows[0].count) * 100).toFixed(2) + '%' : '0%',
                
                conversion_rate: totalMessages.rows[0].count > 0 ?
                    (parseInt(convertedSales.rows[0].count) / parseInt(totalMessages.rows[0].count) * 100).toFixed(2) + '%' : '0%',
                
                duplicate_rate: totalMessages.rows[0].count > 0 ?
                    (parseInt(duplicateMessages.rows[0].count) / parseInt(totalMessages.rows[0].count) * 100).toFixed(2) + '%' : '0%',
                
                // Distribuição por instância
                instance_distribution: instanceStats.rows,
                
                // Verificações de integridade
                final_check_events: parseInt(finalCheckEvents.rows[0].count), // DEVE SER 0
                system_version: this.version,
                database_healthy: finalCheckEvents.rows[0].count === '0'
            };

        } catch (error) {
            logger.error(`❌ Erro ao obter estatísticas: ${error.message}`, error);
            return {
                total_leads: 0,
                active_conversations: 0,
                pending_pix: 0,
                approved_sales: 0,
                converted_sales: 0,
                timeout_sales: 0,
                total_messages: 0,
                queued_events: 0,
                failed_events: 0,
                duplicate_messages: 0,
                success_rate: '0%',
                conversion_rate: '0%',
                duplicate_rate: '0%',
                instance_distribution: [],
                final_check_events: 'unknown',
                system_version: this.version,
                database_healthy: false,
                error: error.message
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Obter estatísticas detalhadas por período
     */
    async getDetailedStats(period = '24h') {
        try {
            let intervalClause;
            switch (period) {
                case '1h': intervalClause = "1 hour"; break;
                case '24h': intervalClause = "24 hours"; break;
                case '7d': intervalClause = "7 days"; break;
                case '30d': intervalClause = "30 days"; break;
                default: intervalClause = "24 hours";
            }

            const stats = await this.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '${intervalClause}') as new_conversations,
                    COUNT(*) FILTER (WHERE c.status = 'approved' AND c.updated_at >= NOW() - INTERVAL '${intervalClause}') as approved_last_period,
                    COUNT(*) FILTER (WHERE c.status = 'convertido' AND c.updated_at >= NOW() - INTERVAL '${intervalClause}') as converted_last_period,
                    COUNT(*) FILTER (WHERE c.status = 'timeout' AND c.updated_at >= NOW() - INTERVAL '${intervalClause}') as timeout_last_period,
                    AVG(c.responses_count) FILTER (WHERE c.updated_at >= NOW() - INTERVAL '${intervalClause}') as avg_responses,
                    SUM(c.amount) FILTER (WHERE c.status IN ('approved', 'completed', 'convertido') AND c.updated_at >= NOW() - INTERVAL '${intervalClause}') as revenue_last_period
                FROM conversations c
            `);

            const messageStats = await this.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE type = 'sent' AND created_at >= NOW() - INTERVAL '${intervalClause}') as sent_messages,
                    COUNT(*) FILTER (WHERE type = 'received' AND created_at >= NOW() - INTERVAL '${intervalClause}') as received_messages,
                    COUNT(*) FILTER (WHERE status = 'duplicate' AND created_at >= NOW() - INTERVAL '${intervalClause}') as duplicate_messages,
                    COUNT(*) FILTER (WHERE type = 'n8n_sent' AND status = 'delivered' AND created_at >= NOW() - INTERVAL '${intervalClause}') as successful_n8n,
                    COUNT(*) FILTER (WHERE type = 'n8n_sent' AND status = 'failed' AND created_at >= NOW() - INTERVAL '${intervalClause}') as failed_n8n
                FROM messages
            `);

            return {
                period: period,
                ...stats.rows[0],
                ...messageStats.rows[0],
                revenue_last_period: parseFloat(stats.rows[0].revenue_last_period || 0).toFixed(2)
            };

        } catch (error) {
            logger.error(`❌ Erro ao obter estatísticas detalhadas: ${error.message}`, error);
            return {
                period: period,
                error: error.message
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Verificar integridade do sistema
     */
    async healthCheck() {
        try {
            const health = {
                timestamp: new Date().toISOString(),
                database_version: this.version,
                connection_status: this.connected ? 'connected' : 'disconnected',
                issues: [],
                warnings: [],
                recommendations: []
            };

            // Verificar conexão
            if (!this.connected) {
                health.issues.push('Banco de dados não conectado');
                return { ...health, overall_status: 'critical' };
            }

            // Verificar se há eventos final_check (CRÍTICO)
            const finalCheckCount = await this.query("SELECT COUNT(*) as count FROM events_queue WHERE event_type = 'final_check'");
            if (parseInt(finalCheckCount.rows[0].count) > 0) {
                health.issues.push(`${finalCheckCount.rows[0].count} evento(s) final_check encontrado(s) - DEVE SER 0`);
            }

            // Verificar eventos falhados
            const failedEvents = await this.query("SELECT COUNT(*) as count FROM events_queue WHERE attempts >= max_attempts AND processed = false");
            if (parseInt(failedEvents.rows[0].count) > 10) {
                health.warnings.push(`Muitos eventos falhados: ${failedEvents.rows[0].count}`);
            }

            // Verificar mensagens duplicadas
            const duplicateRate = await this.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'duplicate') * 100.0 / NULLIF(COUNT(*), 0) as rate
                FROM messages 
                WHERE type = 'received' AND created_at >= NOW() - INTERVAL '24 hours'
            `);
            
            const dupRate = parseFloat(duplicateRate.rows[0].rate || 0);
            if (dupRate > 10) {
                health.warnings.push(`Taxa de duplicatas alta: ${dupRate.toFixed(2)}%`);
            }

            // Verificar distribuição de instâncias
            const instanceBalance = await this.query(`
                SELECT 
                    MAX(lead_count) - MIN(lead_count) as difference
                FROM (
                    SELECT COUNT(*) as lead_count 
                    FROM leads 
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                    GROUP BY instance_name
                ) t
            `);
            
            const imbalance = parseInt(instanceBalance.rows[0].difference || 0);
            if (imbalance > 5) {
                health.warnings.push(`Distribuição desigual entre instâncias: diferença de ${imbalance} leads`);
                health.recommendations.push('Execute rebalanceamento de instâncias');
            }

            // Verificar performance
            const oldestPending = await this.query(`
                SELECT 
                    EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/3600 as hours_old
                FROM events_queue 
                WHERE processed = false
            `);
            
            const hoursOld = parseFloat(oldestPending.rows[0].hours_old || 0);
            if (hoursOld > 24) {
                health.issues.push(`Eventos pendentes há mais de 24h: ${hoursOld.toFixed(1)}h`);
            }

            // Status geral
            if (health.issues.length > 0) {
                health.overall_status = 'critical';
            } else if (health.warnings.length > 0) {
                health.overall_status = 'warning';
            } else {
                health.overall_status = 'healthy';
            }

            return health;

        } catch (error) {
            logger.error(`❌ Erro no health check do banco: ${error.message}`, error);
            return {
                timestamp: new Date().toISOString(),
                database_version: this.version,
                connection_status: 'error',
                overall_status: 'critical',
                error: error.message
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Executar manutenção completa
     */
    async runMaintenance() {
        try {
            logger.info('🔧 Executando manutenção completa do banco...');
            
            const maintenanceResults = {
                timestamp: new Date().toISOString(),
                actions: []
            };

            // 1. Remover eventos final_check
            const finalCheckResult = await this.query("DELETE FROM events_queue WHERE event_type = 'final_check' RETURNING id");
            maintenanceResults.actions.push({
                action: 'remove_final_check_events',
                count: finalCheckResult.rowCount,
                status: 'completed'
            });

            // 2. Normalizar telefones
            await this.normalizeExistingPhones();
            maintenanceResults.actions.push({
                action: 'normalize_phones',
                status: 'completed'
            });

            // 3. Limpeza geral
            await this.cleanup();
            maintenanceResults.actions.push({
                action: 'cleanup_old_data',
                status: 'completed'
            });

            // 4. Atualizar estatísticas das tabelas
            await this.query('ANALYZE leads, conversations, messages, events_queue, system_logs');
            maintenanceResults.actions.push({
                action: 'analyze_tables',
                status: 'completed'
            });

            // 5. Verificar integridade
            const integrity = await this.healthCheck();
            maintenanceResults.actions.push({
                action: 'health_check',
                status: integrity.overall_status,
                issues: integrity.issues,
                warnings: integrity.warnings
            });

            logger.info('✅ Manutenção completa executada');
            return maintenanceResults;

        } catch (error) {
            logger.error(`❌ Erro na manutenção: ${error.message}`, error);
            return {
                timestamp: new Date().toISOString(),
                error: error.message,
                status: 'failed'
            };
        }
    }

    /**
     * NOVA FUNÇÃO - Rebalancear instâncias
     */
    async rebalanceInstances() {
        try {
            logger.info('⚖️ Rebalanceando distribuição de instâncias...');
            
            // Obter estatísticas atuais
            const currentDistribution = await this.query(`
                SELECT instance_name, COUNT(*) as count
                FROM leads 
                WHERE created_at >= NOW() - INTERVAL '30 days'
                GROUP BY instance_name 
                ORDER BY count DESC
            `);

            const rebalanceInfo = {
                timestamp: new Date().toISOString(),
                before: currentDistribution.rows,
                actions_taken: [],
                after: null
            };

            // Identificar instâncias com muitos leads vs poucas
            const counts = currentDistribution.rows.map(row => parseInt(row.count));
            const maxCount = Math.max(...counts);
            const minCount = Math.min(...counts);
            const difference = maxCount - minCount;

            if (difference > 5) {
                logger.info(`📊 Diferença detectada: ${difference} leads entre instâncias mais/menos carregadas`);
                
                // Por enquanto, apenas log - rebalanceamento real pode ser complexo
                rebalanceInfo.actions_taken.push({
                    action: 'analysis_only',
                    difference: difference,
                    recommendation: 'Considerar redistribuição manual se necessário'
                });
            } else {
                logger.info('✅ Distribuição equilibrada, nenhuma ação necessária');
                rebalanceInfo.actions_taken.push({
                    action: 'no_action_needed',
                    reason: 'Distribuição já equilibrada'
                });
            }

            return rebalanceInfo;

        } catch (error) {
            logger.error(`❌ Erro no rebalanceamento: ${error.message}`, error);
            return {
                timestamp: new Date().toISOString(),
                error: error.message
            };
        }
    }
}

// Instância única do banco
const database = new Database();

module.exports = database;
