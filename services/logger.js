/**
 * SISTEMA DE LOGS
 * Gerencia logs do sistema com diferentes níveis e persistência em banco
 */

const fs = require('fs').promises;
const path = require('path');

class Logger {
    constructor() {
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.logLevels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        this.database = null; // Será injetado para evitar dependência circular
        this.logBuffer = []; // Buffer para logs quando banco não estiver disponível
    }

    /**
     * Configurar referência do banco (chamado após inicialização)
     */
    setDatabase(database) {
        this.database = database;
        // Processar logs em buffer
        this.flushBuffer();
    }

    /**
     * Obter horário de Brasília formatado
     */
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
     * Verificar se deve logar baseado no nível
     */
    shouldLog(level) {
        return this.logLevels[level] <= this.logLevels[this.logLevel];
    }

    /**
     * Formatar log para console
     */
    formatConsoleLog(level, message, meta = null) {
        const timestamp = this.getBrazilTime();
        const levelUpper = level.toUpperCase().padEnd(5);
        
        let logMessage = `[${timestamp}] ${levelUpper}: ${message}`;
        
        if (meta) {
            if (typeof meta === 'object') {
                logMessage += '\n' + JSON.stringify(meta, null, 2);
            } else {
                logMessage += ` | ${meta}`;
            }
        }
        
        return logMessage;
    }

    /**
     * Salvar log no arquivo
     */
    async saveToFile(level, message, meta = null) {
        try {
            const logDir = path.join(process.cwd(), 'logs');
            
            // Criar diretório se não existir
            try {
                await fs.mkdir(logDir, { recursive: true });
            } catch (err) {
                // Diretório já existe
            }
            
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const logFile = path.join(logDir, `${today}.log`);
            
            const logEntry = {
                timestamp: new Date().toISOString(),
                brazil_time: this.getBrazilTime(),
                level: level,
                message: message,
                meta: meta,
                process_id: process.pid
            };
            
            const logLine = JSON.stringify(logEntry) + '\n';
            await fs.appendFile(logFile, logLine);
            
        } catch (error) {
            console.error(`Erro ao salvar log em arquivo: ${error.message}`);
        }
    }

    /**
     * Salvar log no banco de dados
     */
    async saveToDatabase(level, message, meta = null) {
        try {
            if (!this.database || !this.database.isConnected()) {
                // Se banco não disponível, adicionar ao buffer
                this.logBuffer.push({ level, message, meta, timestamp: new Date() });
                
                // Limitar buffer para não usar muita memória
                if (this.logBuffer.length > 1000) {
                    this.logBuffer = this.logBuffer.slice(-500);
                }
                return;
            }

            await this.database.query(
                'INSERT INTO system_logs (level, message, meta, created_at) VALUES ($1, $2, $3, NOW())',
                [level, message, meta ? JSON.stringify(meta) : null]
            );

        } catch (error) {
            // Falha silenciosa para não criar loop de log
            console.error(`Erro ao salvar log no banco: ${error.message}`);
        }
    }

    /**
     * Processar logs em buffer (quando banco fica disponível)
     */
    async flushBuffer() {
        if (this.logBuffer.length === 0 || !this.database || !this.database.isConnected()) {
            return;
        }

        try {
            const logs = [...this.logBuffer];
            this.logBuffer = [];

            for (const log of logs) {
                await this.database.query(
                    'INSERT INTO system_logs (level, message, meta, created_at) VALUES ($1, $2, $3, $4)',
                    [log.level, log.message, log.meta ? JSON.stringify(log.meta) : null, log.timestamp]
                );
            }

        } catch (error) {
            console.error(`Erro ao processar buffer de logs: ${error.message}`);
        }
    }

    /**
     * Log genérico
     */
    async log(level, message, meta = null) {
        if (!this.shouldLog(level)) {
            return;
        }

        const formattedLog = this.formatConsoleLog(level, message, meta);
        
        // Escolher cor baseada no nível
        if (level === 'error') {
            console.error('\x1b[31m%s\x1b[0m', formattedLog); // Vermelho
        } else if (level === 'warn') {
            console.warn('\x1b[33m%s\x1b[0m', formattedLog); // Amarelo
        } else if (level === 'info') {
            console.info('\x1b[36m%s\x1b[0m', formattedLog); // Ciano
        } else {
            console.log('\x1b[90m%s\x1b[0m', formattedLog); // Cinza
        }

        // Salvar em arquivo e banco (de forma assíncrona para não bloquear)
        setImmediate(() => {
            this.saveToFile(level, message, meta);
            this.saveToDatabase(level, message, meta);
        });
    }

    /**
     * Métodos específicos por nível
     */
    async error(message, meta = null) {
        await this.log('error', message, meta);
    }

    async warn(message, meta = null) {
        await this.log('warn', message, meta);
    }

    async info(message, meta = null) {
        await this.log('info', message, meta);
    }

    async debug(message, meta = null) {
        await this.log('debug', message, meta);
    }

    /**
     * Log de evento específico do sistema
     */
    async logEvent(eventType, data) {
        const message = `${eventType.toUpperCase()}: ${data.orderCode || 'N/A'} | ${data.product || 'N/A'} | ${data.clientName || 'N/A'}`;
        await this.info(message, data);
    }

    /**
     * Log de webhook recebido
     */
    async logWebhook(source, data) {
        const message = `WEBHOOK ${source.toUpperCase()}: ${JSON.stringify(data).substring(0, 200)}...`;
        await this.info(message, { source, payload_size: JSON.stringify(data).length });
    }

    /**
     * Log de resposta de API
     */
    async logApiResponse(api, status, responseTime) {
        const message = `API ${api.toUpperCase()}: Status ${status} | ${responseTime}ms`;
        if (status >= 400) {
            await this.warn(message);
        } else {
            await this.info(message);
        }
    }

    /**
     * Log de erro de banco de dados
     */
    async logDatabaseError(operation, error) {
        const message = `DATABASE ERROR ${operation}: ${error.message}`;
        await this.error(message, { 
            operation, 
            error: error.message, 
            stack: error.stack?.substring(0, 500) 
        });
    }

    /**
     * Obter logs recentes do banco
     */
    async getRecentLogs(limit = 100, level = null) {
        try {
            if (!this.database || !this.database.isConnected()) {
                return [];
            }

            let query = 'SELECT * FROM system_logs';
            let params = [];

            if (level) {
                query += ' WHERE level = $1';
                params.push(level);
            }

            query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
            params.push(limit);

            const result = await this.database.query(query, params);
            return result.rows.map(row => ({
                ...row,
                meta: row.meta ? JSON.parse(row.meta) : null,
                brazil_time: new Date(row.created_at).toLocaleString('pt-BR', { 
                    timeZone: 'America/Sao_Paulo' 
                })
            }));

        } catch (error) {
            console.error(`Erro ao obter logs: ${error.message}`);
            return [];
        }
    }

    /**
     * Limpar logs antigos
     */
    async cleanupOldLogs() {
        try {
            const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS) || 7;
            const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

            if (this.database && this.database.isConnected()) {
                const result = await this.database.query(
                    'DELETE FROM system_logs WHERE created_at < $1',
                    [cutoffDate]
                );
                
                await this.info(`Limpeza de logs executada: ${result.rowCount} registros removidos`);
            }

            // Limpar arquivos de log antigos
            const logDir = path.join(process.cwd(), 'logs');
            try {
                const files = await fs.readdir(logDir);
                
                for (const file of files) {
                    if (file.endsWith('.log')) {
                        const filePath = path.join(logDir, file);
                        const stats = await fs.stat(filePath);
                        
                        if (stats.mtime < cutoffDate) {
                            await fs.unlink(filePath);
                            console.log(`Arquivo de log removido: ${file}`);
                        }
                    }
                }
            } catch (error) {
                // Ignora erro se diretório não existir
            }

        } catch (error) {
            console.error(`Erro na limpeza de logs: ${error.message}`);
        }
    }

    /**
     * Obter estatísticas de logs
     */
    async getLogStats() {
        try {
            if (!this.database || !this.database.isConnected()) {
                return {
                    total: 0,
                    by_level: {},
                    last_24h: 0
                };
            }

            const [total, byLevel, last24h] = await Promise.all([
                this.database.query('SELECT COUNT(*) as count FROM system_logs'),
                this.database.query('SELECT level, COUNT(*) as count FROM system_logs GROUP BY level'),
                this.database.query('SELECT COUNT(*) as count FROM system_logs WHERE created_at > NOW() - INTERVAL \'24 hours\'')
            ]);

            const levelStats = {};
            byLevel.rows.forEach(row => {
                levelStats[row.level] = parseInt(row.count);
            });

            return {
                total: parseInt(total.rows[0].count),
                by_level: levelStats,
                last_24h: parseInt(last24h.rows[0].count),
                buffer_size: this.logBuffer.length
            };

        } catch (error) {
            console.error(`Erro ao obter estatísticas de logs: ${error.message}`);
            return {
                total: 0,
                by_level: {},
                last_24h: 0,
                buffer_size: this.logBuffer.length
            };
        }
    }
}

// Instância única do logger
const logger = new Logger();

module.exports = logger;
