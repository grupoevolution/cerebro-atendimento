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

        logger.error('CRÍTICO: Todas as instâncias falharam no fallback');
        return {
            success: false,
            error: 'Todas as instâncias falharam',
            instance: null
        };
    }

    /**
     * Obter detalhes de todas as instâncias
     */
    getAllInstancesDetails() {
        return this.instances.map(instance => ({
            name: instance.name,
            id: instance.id,
            status: instance.status,
            active: instance.active,
            lastCheck: instance.lastCheck ? instance.lastCheck.toISOString() : null,
            lastCheckBrazil: instance.lastCheck ? 
                instance.lastCheck.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null
        }));
    }

    /**
     * Parar health checks (chamado no shutdown)
     */
    cleanup() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            logger.info('Health check Evolution parado');
        }
    }
}

// Instância única do serviço
const evolutionService = new EvolutionService();

module.exports = evolutionService;
