/**
 * SERVIÇO EVOLUTION API
 * Integração com Evolution API para WhatsApp
 * Inclui health check de instâncias e fallback
 */

const axios = require('axios');
const logger = require('./logger');

class EvolutionService {
    constructor() {
        this.baseURL = process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun';
        this.instances = [
            { name: 'GABY01', id: '1CEBB8703497-4F31-B33F-335A4233D2FE', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY02', id: '939E26DEA1FA-40D4-83CE-2BF0B3F795DC', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY03', id: 'F819629B5E33-435B-93BB-091B4C104C12', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY04', id: 'D555A7CBC0B3-425B-8E20-975232BE75F6', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY05', id: 'D97A63B8B05B-430E-98C1-61977A51EC0B', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY06', id: '6FC2C4C703BA-4A8A-9B3B-21536AE51323', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY07', id: '14F637AB35CD-448D-BF66-5673950FBA10', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY08', id: '82E0CE5B1A51-4B7B-BBEF-77D22320B482', active: true, lastCheck: null, status: 'unknown' },
            { name: 'GABY09', id: 'B5783C928EF4-4DB0-ABBA-AF6913116E7B', active: true, lastCheck: null, status: 'unknown' }
        ];
        this.healthCheckInterval = null;
    }

    /**
     * Inicializar serviço Evolution
     */
    async initialize() {
        try {
            logger.info('Inicializando serviço Evolution API...');
            
            // Primeira verificação de saúde
            await this.checkAllInstances();
            
            // Configurar verificação periódica a cada 5 minutos
            this.healthCheckInterval = setInterval(async () => {
                await this.checkAllInstances();
            }, 5 * 60 * 1000);
            
            logger.info('Serviço Evolution inicializado com health check automático');
            
        } catch (error) {
            logger.error(`Erro ao inicializar serviço Evolution: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Verificar saúde de todas as instâncias
     */
    async checkAllInstances() {
        logger.info('Executando health check de todas as instâncias...');
        
        const checkPromises = this.instances.map(instance => this.checkInstanceHealth(instance));
        const results = await Promise.allSettled(checkPromises);
        
        let activeCount = 0;
        let inactiveCount = 0;
        
        results.forEach((result, index) => {
            const instance = this.instances[index];
            
            if (result.status === 'fulfilled' && result.value) {
                instance.status = 'online';
                instance.active = true;
                activeCount++;
            } else {
                instance.status = 'offline';
                instance.active = false;
                inactiveCount++;
                
                logger.warn(`Instância ${instance.name} offline ou com problemas`);
            }
            
            instance.lastCheck = new Date();
        });
        
        logger.info(`Health check concluído: ${activeCount} online, ${inactiveCount} offline`);
        
        // Se muitas instâncias estão offline, alerta crítico
        if (inactiveCount > 5) {
            logger.error(`ALERTA CRÍTICO: ${inactiveCount} instâncias offline de ${this.instances.length} total`);
        }
    }

    /**
     * Verificar saúde de uma instância específica
     */
    async checkInstanceHealth(instance) {
        try {
            const response = await axios.get(`${this.baseURL}/instance/connectionState/${instance.name}`, {
                timeout: 10000,
                headers: {
                    'apikey': instance.id
                }
            });
            
            const isConnected = response.data?.instance?.state === 'open';
            
            if (isConnected) {
                logger.debug(`Instância ${instance.name} está online`);
                return true;
            } else {
                logger.warn(`Instância ${instance.name} não está conectada: ${response.data?.instance?.state || 'unknown'}`);
                return false;
            }
            
        } catch (error) {
            logger.warn(`Erro ao verificar instância ${instance.name}: ${error.message}`);
            return false;
        }
    }

    /**
     * Obter instâncias ativas (para balanceamento de carga)
     */
    getActiveInstances() {
        return this.instances.filter(instance => instance.active && instance.status === 'online');
    }

    /**
     * Obter instância por nome
     */
    getInstance(instanceName) {
        return this.instances.find(instance => instance.name === instanceName);
    }

    /**
     * Enviar mensagem via Evolution API
     */
    async sendMessage(instanceName, phoneNumber, message, retryCount = 0) {
        const maxRetries = 3;
        
        try {
            const instance = this.getInstance(instanceName);
            
            if (!instance) {
                throw new Error(`Instância ${instanceName} não encontrada`);
            }
            
            // Se instância está offline, tentar fallback
            if (!instance.active || instance.status === 'offline') {
                logger.warn(`Instância ${instanceName} offline, tentando fallback...`);
                return await this.sendMessageWithFallback(phoneNumber, message);
            }
            
            const payload = {
                number: phoneNumber,
                textMessage: {
                    text: message
                }
            };
            
            const response = await axios.post(
                `${this.baseURL}/message/sendText/${instanceName}`,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': instance.id
                    },
                    timeout: 15000
                }
            );
            
            if (response.status === 200) {
                logger.info(`Mensagem enviada via ${instanceName}: ${phoneNumber}`);
                return {
                    success: true,
                    instance: instanceName,
                    messageId: response.data?.key?.id,
                    response: response.data
                };
            } else {
                throw new Error(`Status HTTP ${response.status}`);
            }
            
        } catch (error) {
            logger.error(`Erro ao enviar mensagem via ${instanceName}: ${error.message}`);
            
            // Tentar retry ou fallback
            if (retryCount < maxRetries) {
                logger.info(`Tentando novamente (${retryCount + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Delay de 2s
                return await this.sendMessage(instanceName, phoneNumber, message, retryCount + 1);
            } else {
                // Tentar fallback com outras instâncias
                logger.warn(`Falha em todas as tentativas para ${instanceName}, tentando fallback...`);
                return await this.sendMessageWithFallback(phoneNumber, message);
            }
        }
    }

    /**
     * Enviar mensagem com fallback (tenta outras instâncias disponíveis)
     */
    async sendMessageWithFallback(phoneNumber, message) {
        const activeInstances = this.getActiveInstances();
        
        if (activeInstances.length === 0) {
            logger.error('CRÍTICO: Nenhuma instância ativa disponível para fallback');
            return {
                success: false,
                error: 'Nenhuma instância disponível',
                instance: null
            };
        }
        
        // Tentar cada instância ativa
        for (const instance of activeInstances) {
            try {
                logger.info(`Tentando fallback via ${instance.name}...`);
                
                const result = await this.sendMessage(instance.name, phoneNumber, message, 0);
                
                if (result.success) {
                    logger.info(`Fallback bem-sucedido via ${instance.name}`);
                    return result;
                }
                
            } catch (error) {
                logger.warn(`Fallback falhou via ${instance.name}: ${error.message}`);
                continue;
            }
        }
