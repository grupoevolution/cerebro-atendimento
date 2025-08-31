/**
 * CONFIGURAÇÃO DO BANCO DE DADOS POSTGRESQL
 * Módulo responsável pela conexão e operações com PostgreSQL Hostinger
 */

const { Pool } = require('pg');
const logger = require('../services/logger');

class Database {
    constructor() {
        this.pool = null;
        this.connected = false;
    }

    /**
     * Conectar ao PostgreSQL
     */
    async connect() {
        try {
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
            await client.query('SELECT NOW()');
            client.release();

            this.connected = true;
            logger.info('Conexão PostgreSQL estabelecida com sucesso');

            // Configurar eventos do pool
            this.pool.on('error', (err) => {
                logger.error('Erro no pool PostgreSQL:', err);
                this.connected = false;
            });

            this.pool.on('connect', () => {
                logger.info('Nova conexão PostgreSQL estabelecida');
            });

        } catch (error) {
            logger.error(`Erro ao conectar PostgreSQL: ${error.message}`, error);
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
                logger.info('Conexão PostgreSQL encerrada');
            }
        } catch (error) {
            logger.error(`Erro ao desconectar PostgreSQL: ${error.message}`, error);
        }
    }

    /**
     * Executar query
     */
    async query(text, params = []) {
        if (!this.connected || !this.pool) {
            throw new Error('Banco de dados não conectado');
        }

        try {
            const start = Date.now();
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;

            // Log apenas queries lentas (>1s)
            if (duration > 1000) {
                logger.warn(`Query lenta (${duration}ms): ${text.substring(0, 100)}...`);
            }

            return result;
        } catch (error) {
            logger.error(`Erro na query: ${error.message}`, { 
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
            logger.error(`Erro na transação: ${error.message}`, error);
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
     * Executar migrações do banco
     */
    async migrate() {
        try {
            logger.info('Executando migrações do banco de dados...');

            // Criar tabela de leads (sticky session)
            await this.query(`
                CREATE TABLE IF NOT EXISTS leads (
                    phone VARCHAR(20) PRIMARY KEY,
                    instance_name VARCHAR(10) NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Criar tabela de conversas
            await this.query(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id SERIAL PRIMARY KEY,
                    phone VARCHAR(20) NOT NULL,
                    order_code VARCHAR(50) UNIQUE NOT NULL,
                    product VARCHAR(10),
                    status VARCHAR(20) DEFAULT 'pix_pending', -- 'pix_pending', 'approved', 'completed', 'timeout'
                    current_step INTEGER DEFAULT 0,
                    responses_count INTEGER DEFAULT 0,
                    instance_name VARCHAR(10),
                    amount DECIMAL(10,2) DEFAULT 0,
                    pix_url TEXT,
                    client_name VARCHAR(255),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Criar tabela de mensagens
            await this.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                    type VARCHAR(20) NOT NULL, -- 'sent', 'received', 'system_event'
                    content TEXT,
                    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'failed'
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Criar tabela de eventos para reprocessamento
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
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Criar tabela de logs do sistema
            await this.query(`
                CREATE TABLE IF NOT EXISTS system_logs (
                    id SERIAL PRIMARY KEY,
                    level VARCHAR(10) NOT NULL,
                    message TEXT NOT NULL,
                    meta JSONB,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Criar índices para performance
            await this.query(`
                CREATE INDEX IF NOT EXISTS idx_leads_instance ON leads(instance_name);
                CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
                CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
                CREATE INDEX IF NOT EXISTS idx_conversations_order_code ON conversations(order_code);
                CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_events_queue_processed ON events_queue(processed);
                CREATE INDEX IF NOT EXISTS idx_events_queue_scheduled ON events_queue(scheduled_for);
                CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
            `);

            // Função para atualizar updated_at automaticamente
            await this.query(`
                CREATE OR REPLACE FUNCTION update_updated_at_column()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.updated_at = NOW();
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

            // Adicionar colunas se não existirem (para migrações de versões antigas)
            try {
                await this.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);`);
            } catch (error) {
                // Ignora erro se coluna já existir
            }

            // Limpar logs antigos (mais de 7 dias)
            await this.query(`
                DELETE FROM system_logs 
                WHERE created_at < NOW() - INTERVAL '7 days';
            `);

            logger.info('Migrações executadas com sucesso');

        } catch (error) {
            logger.error(`Erro ao executar migrações: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Limpar dados antigos (executado periodicamente)
     */
    async cleanup() {
        try {
            const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 dias

            // Limpar conversas antigas completadas
            const deletedConversations = await this.query(`
                DELETE FROM conversations 
                WHERE status = 'completed' AND updated_at < $1
                RETURNING id;
            `, [cutoffDate]);

            // Limpar eventos processados antigos
            const deletedEvents = await this.query(`
                DELETE FROM events_queue 
                WHERE processed = true AND created_at < $1
                RETURNING id;
            `, [cutoffDate]);

            // Limpar logs antigos
            const deletedLogs = await this.query(`
                DELETE FROM system_logs 
                WHERE created_at < $1
                RETURNING id;
            `, [cutoffDate]);

            logger.info(`Limpeza executada: ${deletedConversations.rowCount} conversas, ${deletedEvents.rowCount} eventos, ${deletedLogs.rowCount} logs removidos`);

        } catch (error) {
            logger.error(`Erro na limpeza do banco: ${error.message}`, error);
        }
    }

    /**
     * Obter estatísticas do banco
     */
    async getStats() {
        try {
            const [
                totalLeads,
                activeConversations,
                pendingPix,
                approvedSales,
                totalMessages,
                queuedEvents
            ] = await Promise.all([
                this.query('SELECT COUNT(*) as count FROM leads'),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status IN ('pix_pending', 'approved')"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status = 'pix_pending'"),
                this.query("SELECT COUNT(*) as count FROM conversations WHERE status IN ('approved', 'completed')"),
                this.query('SELECT COUNT(*) as count FROM messages'),
                this.query('SELECT COUNT(*) as count FROM events_queue WHERE processed = false')
            ]);

            return {
                total_leads: parseInt(totalLeads.rows[0].count),
                active_conversations: parseInt(activeConversations.rows[0].count),
                pending_pix: parseInt(pendingPix.rows[0].count),
                approved_sales: parseInt(approvedSales.rows[0].count),
                total_messages: parseInt(totalMessages.rows[0].count),
                queued_events: parseInt(queuedEvents.rows[0].count)
            };

        } catch (error) {
            logger.error(`Erro ao obter estatísticas: ${error.message}`, error);
            return {
                total_leads: 0,
                active_conversations: 0,
                pending_pix: 0,
                approved_sales: 0,
                total_messages: 0,
                queued_events: 0
            };
        }
    }
}

// Instância única do banco
const database = new Database();

module.exports = database;
