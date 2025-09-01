/**
 * SERVIÇO EVOLUTION API - VERSÃO CORRIGIDA
 * Integração com Evolution API para WhatsApp
 * Inclui detecção automática do endpoint correto e health check
 * 
 * CORREÇÕES:
 * ✅ Detecção automática do endpoint correto
 * ✅ Teste de múltiplos endpoints possíveis
 * ✅ Fallback inteligente entre instâncias
 * ✅ Logs de debug detalhados
 */

const axios = require('axios');
const logger = require('./logger');

class EvolutionService {
    constructor() {
        this.baseURL = process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun';
        this.workingEndpoint = null; // Endpoint que funciona será descoberto
        
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
        
        // Lista de endpoints possíveis para testar (problema 2)
        this.possibleEndpoints = [
            '/instance/connectionState',
            '/instance/connect',
            '/instance/fetchInstances', 
            '/instance/status'
        ];
        
        this.healthCheckInterval = null;
    }

    /**
     * Descobrir endpoint correto da Evolution API
     */
    async discoverWorkingEndpoint() {
        logger.info('🔍 Descobrindo endpoint correto da Evolution API...');
        
        // Testar com a primeira instância para descobrir o endpoint
        const testInstance = this.instances[0];
        
        for (const endpoint of this.possibleEndpoints) {
            try {
                logger.debug(`Testando endpoint: ${endpoint}/${testInstance.name}`);
                
                const response = await axios.get(`${this.baseURL}${endpoint}/${testInstance.name}`, {
                    timeout: 10000,
                    headers: { 'apikey': testInstance.id }
                });
                
                // Verificar diferentes formatos de resposta possíveis
                const isConnected = this.checkConnectionResponse(response.data);
                
                if (response.status === 200 && response.data) {
                    this.workingEndpoint = endpoint;
                    logger.info(`✅ Endpoint funcionando descoberto: ${endpoint}`);
                    logger.debug(`Resposta de exemplo:`, response.data);
                    return endpoint;
                }
                
            } catch (error) {
                logger.debug(`Endpoint ${endpoint} falhou: ${error.response?.status || error.message}`);
                
                // Se for erro 404, endpoint não existe
                if (error.response?.status === 404) {
                    logger.debug(`❌ Endpoint ${endpoint} não existe nesta Evolution API`);
                } else {
                    logger.debug(`⚠️ Endpoint ${endpoint} existe mas falhou: ${error.message}`);
                }
                continue;
            }
        }
        
        logger.error('❌ Nenhum endpoint Evolution funcional encontrado!');
        logger.error('📋 Endpoints testados:', this.possibleEndpoints);
        logger.error('🔧 Verifique se a Evolution API está rodando e acessível');
        
        return null;
    }

    /**
     * Verificar se a resposta indica conexão ativa
     */
    checkConnectionResponse(data) {
        if (!data) return false;
        
        // Diferentes formatos possíveis de resposta
        return (
            data?.instance?.state === 'open' ||
            data?.state === 'open' ||
            data?.status === 'open' ||
            data?.connected === true ||
            data?.connectionStatus === 'open' ||
            (Array.isArray(data) && data.length > 0) // Para fetchInstances
        );
    }

    /**
     * Inicializar serviço Evolution
     */
    async initialize() {
        try {
            logger.info('🚀 Inicializando serviço Evolution API...');
            
            // Descobrir endpoint correto primeiro
            const workingEndpoint = await this.discoverWorkingEndpoint();
            
            if (!workingEndpoint) {
                logger.warn('⚠️ Nenhum endpoint Evolution encontrado - continuando sem health check automático');
                return;
            }
            
            // Primeira verificação de saúde usando o endpoint descoberto
            await this.checkAllInstances();
            
            // Configurar verificação periódica a cada 5 minutos
            this.healthCheckInterval = setInterval(async () => {
                await this.checkAllInstances();
            }, 5 * 60 * 1000);
            
            logger.info(`✅ Serviço Evolution inicializado com endpoint: ${workingEndpoint}`);
            
        } catch (error) {
            logger.error(`❌ Erro ao inicializar serviço Evolution: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Verificar saúde de todas as instâncias
     */
    async checkAllInstances() {
        if (!this.workingEndpoint) {
            logger.warn('⚠️ Endpoint Evolution não descoberto - pulando health check');
            return;
        }
        
        logger.info('🔍 Executando health check de todas as instâncias...');
        
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
                logger.debug(`✅ ${instance.name} online`);
            } else {
                instance.status = 'offline';
                instance.active = false;
                inactiveCount++;
                
                const error = result.status === 'rejected' ? result.reason : 'Status offline';
                logger.debug(`❌ ${instance.name} offline: ${error.message || error}`);
            }
            
            instance.lastCheck = new Date();
        });
        
        logger.info(`📊 Health check concluído: ${activeCount} online, ${inactiveCount} offline`);
        
        // Se muitas instâncias estão offline, alerta crítico
        if (inactiveCount > 6) {
            logger.error(`🚨 ALERTA CRÍTICO: ${inactiveCount} instâncias offline de ${this.instances.length} total`);
        } else if (inactiveCount > 3) {
            logger.warn(`⚠️ ALERTA: ${inactiveCount} instâncias offline de ${this.instances.length} total`);
        }
    }

    /**
     * Verificar saúde de uma instância específica
     */
    async checkInstanceHealth(instance) {
        if (!this.workingEndpoint) {
            return false;
        }
        
        try {
            logger.debug(`Verificando ${instance.name} via ${this.workingEndpoint}`);
            
            const response = await axios.get(`${this.baseURL}${this.workingEndpoint}/${instance.name}`, {
                timeout: 10000,
                headers: {
                    'apikey': instance.id,
                    'Content-Type': 'application/json'
                }
            });
            
            const isConnected = this.checkConnectionResponse(response.data);
            
            if (isConnected) {
                logger.debug(`✅ Instância ${instance.name} está online`);
                return true;
            } else {
                logger.debug(`❌ Instância ${instance.name} não está conectada - resposta:`, response.data);
                return false;
            }
            
        } catch (error) {
            const errorMsg = error.response ? 
                `HTTP ${error.response.status}: ${error.response.statusText}` : 
                error.message;
            
            logger.debug(`❌ Erro ao verificar instância ${instance.name}: ${errorMsg}`);
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
            logger.error('🚨 CRÍTICO: Nenhuma instância ativa disponível para fallback');
            return {
                success: false,
                error: 'Nenhuma instância disponível',
                instance: null
            };
        }
        
        logger.info(`🔄 Tentando fallback com ${activeInstances.length} instâncias ativas`);
        
        // Tentar cada instância ativa
        for (const instance of activeInstances) {
            try {
                logger.info(`📤 Tentando fallback via ${instance.name}...`);
                const result = await this.sendMessage(instance.name, phoneNumber, message);
                
                if (result.success) {
                    logger.info(`✅ Fallback bem-sucedido via ${instance.name}`);
                    return result;
                }
                
            } catch (error) {
                logger.warn(`❌ Fallback falhou via ${instance.name}: ${error.message}`);
                continue;
            }
        }

        logger.error('🚨 CRÍTICO: Todas as instâncias falharam no fallback');
        return {
            success: false,
            error: 'Todas as instâncias falharam',
            instance: null
        };
    }

    /**
     * Enviar mensagem via instância específica
     */
    async sendMessage(instanceName, phoneNumber, message) {
        try {
            const instance = this.getInstance(instanceName);
            if (!instance) {
                throw new Error(`Instância ${instanceName} não encontrada`);
            }
            
            logger.info(`📤 Enviando mensagem via ${instanceName} para ${phoneNumber}`);
            
            const payload = {
                number: phoneNumber,
                text: message
            };
            
            const response = await axios.post(`${this.baseURL}/message/sendText/${instanceName}`, payload, {
                timeout: 15000,
                headers: {
                    'apikey': instance.id,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.status === 200 || response.status === 201) {
                logger.info(`✅ Mensagem enviada com sucesso via ${instanceName}`);
                return {
                    success: true,
                    instance: instanceName,
                    response: response.data
                };
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
        } catch (error) {
            const errorMsg = error.response ? 
                `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}` : 
                error.message;
            
            logger.error(`❌ Erro ao enviar mensagem via ${instanceName}: ${errorMsg}`);
            
            return {
                success: false,
                error: errorMsg,
                instance: instanceName
            };
        }
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
                instance.lastCheck.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null,
            workingEndpoint: this.workingEndpoint
        }));
    }

    /**
     * Testar conectividade de uma instância específica
     */
    async testInstance(instanceName) {
        const instance = this.getInstance(instanceName);
        if (!instance) {
            return {
                success: false,
                error: `Instância ${instanceName} não encontrada`
            };
        }
        
        logger.info(`🧪 Testando conectividade da instância ${instanceName}...`);
        
        const isHealthy = await this.checkInstanceHealth(instance);
        
        return {
            success: isHealthy,
            instance: instanceName,
            status: isHealthy ? 'online' : 'offline',
            endpoint: this.workingEndpoint,
            message: isHealthy ? 'Instância conectada' : 'Instância offline ou inacessível'
        };
    }

    /**
     * Forçar redescoberta do endpoint
     */
    async rediscoverEndpoint() {
        logger.info('🔄 Forçando redescoberta do endpoint Evolution...');
        
        this.workingEndpoint = null;
        const newEndpoint = await this.discoverWorkingEndpoint();
        
        if (newEndpoint) {
            // Fazer nova verificação com o endpoint descoberto
            await this.checkAllInstances();
        }
        
        return {
            success: !!newEndpoint,
            endpoint: newEndpoint,
            message: newEndpoint ? 
                `Novo endpoint descoberto: ${newEndpoint}` : 
                'Nenhum endpoint funcional encontrado'
        };
    }

    /**
     * Obter estatísticas do serviço
     */
    getServiceStats() {
        const onlineInstances = this.instances.filter(i => i.status === 'online').length;
        const offlineInstances = this.instances.filter(i => i.status === 'offline').length;
        const unknownInstances = this.instances.filter(i => i.status === 'unknown').length;
        
        return {
            total_instances: this.instances.length,
            online_instances: onlineInstances,
            offline_instances: offlineInstances,
            unknown_instances: unknownInstances,
            working_endpoint: this.workingEndpoint,
            base_url: this.baseURL,
            last_check: this.instances[0]?.lastCheck || null,
            health_check_active: !!this.healthCheckInterval
        };
    }

    /**
     * Parar health checks (chamado no shutdown)
     */
    cleanup() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            logger.info('✅ Health check Evolution parado');
        }
    }
}

// Instância única do serviço
const evolutionService = new EvolutionService();

module.exports = evolutionService;
