/**
 * VALIDADOR DE SISTEMA - Cérebro de Atendimento v3.1
 * Valida todas as configurações antes de iniciar o sistema
 * Executar com: node system-validator.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

class SystemValidator {
    constructor() {
        this.errors = [];
        this.warnings = [];
        this.info = [];
    }

    /**
     * Executar todas as validações
     */
    async validate() {
        console.log('🔍 VALIDANDO CONFIGURAÇÃO DO SISTEMA CÉREBRO v3.1\n');
        
        this.validateEnvironmentFile();
        this.validateEnvironmentVariables();
        this.validateUrls();
        await this.validateDatabaseConnection();
        await this.validateEvolutionApi();
        await this.validateN8nWebhook();
        
        this.printResults();
        return this.errors.length === 0;
    }

    /**
     * Validar arquivo .env
     */
    validateEnvironmentFile() {
        console.log('📁 Validando arquivos de configuração...');
        
        const envPath = path.join(process.cwd(), '.env');
        const envExamplePath = path.join(process.cwd(), '.env.example');
        
        if (!fs.existsSync(envPath)) {
            this.errors.push({
                component: 'Environment',
                issue: 'Arquivo .env não encontrado',
                solution: 'Crie o arquivo .env baseado no .env.example com suas credenciais reais'
            });
            
            if (fs.existsSync(envExamplePath)) {
                this.info.push('Arquivo .env.example encontrado - use como base para criar .env');
            }
        } else {
            this.info.push('✅ Arquivo .env encontrado');
            
            // Verificar se não está usando o example
            const envContent = fs.readFileSync(envPath, 'utf8');
            if (envContent.includes('SEU_USUARIO') || envContent.includes('SUA_SENHA')) {
                this.warnings.push({
                    component: 'Environment',
                    issue: 'Arquivo .env parece conter valores de exemplo',
                    solution: 'Substitua todos os valores de exemplo pelas suas credenciais reais'
                });
            }
        }
    }

    /**
     * Validar variáveis de ambiente
     */
    validateEnvironmentVariables() {
        console.log('🔧 Validando variáveis de ambiente...');
        
        const required = [
            'N8N_WEBHOOK_URL',
            'EVOLUTION_API_URL'
        ];
        
        const databaseRequired = [
            'DATABASE_URL', // ou as variáveis individuais
            'DB_HOST',
            'DB_USER', 
            'DB_PASSWORD',
            'DB_NAME'
        ];
        
        // Verificar variáveis obrigatórias
        const missing = required.filter(varName => !process.env[varName]);
        if (missing.length > 0) {
            this.errors.push({
                component: 'Environment Variables',
                issue: `Variáveis obrigatórias ausentes: ${missing.join(', ')}`,
                solution: 'Configure todas as variáveis obrigatórias no arquivo .env'
            });
        }
        
        // Verificar configuração do banco
        const hasDatabaseUrl = !!process.env.DATABASE_URL;
        const hasIndividualVars = process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME;
        
        if (!hasDatabaseUrl && !hasIndividualVars) {
            this.errors.push({
                component: 'Database Configuration',
                issue: 'Configuração de banco incompleta',
                solution: 'Configure DATABASE_URL ou todas as variáveis individuais (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)'
            });
        } else if (hasDatabaseUrl) {
            this.info.push('✅ Configuração de banco via DATABASE_URL');
        } else {
            this.info.push('✅ Configuração de banco via variáveis individuais');
        }
        
        // Verificar senha com caracteres especiais
        const password = process.env.DB_PASSWORD;
        if (password && (password.includes('@') || password.includes('#') || password.includes('%'))) {
            this.warnings.push({
                component: 'Database Password',
                issue: 'Senha contém caracteres especiais',
                solution: 'Se houver erro de conexão, use codificação URL (@ = %40, # = %23, etc.)'
            });
        }
        
        // Verificar configurações opcionais
        const optional = {
            'PIX_TIMEOUT': process.env.PIX_TIMEOUT || '420000',
            'MAX_RETRY_ATTEMPTS': process.env.MAX_RETRY_ATTEMPTS || '3',
            'PORT': process.env.PORT || '3000',
            'LOG_LEVEL': process.env.LOG_LEVEL || 'info'
        };
        
        Object.entries(optional).forEach(([key, value]) => {
            this.info.push(`📋 ${key}: ${value}`);
        });
    }

    /**
     * Validar URLs das APIs
     */
    validateUrls() {
        console.log('🌐 Validando URLs das APIs...');
        
        const urls = [
            { name: 'N8N_WEBHOOK_URL', url: process.env.N8N_WEBHOOK_URL },
            { name: 'EVOLUTION_API_URL', url: process.env.EVOLUTION_API_URL }
        ];
        
        urls.forEach(({ name, url }) => {
            if (!url) return;
            
            try {
                new URL(url);
                this.info.push(`✅ ${name}: ${url}`);
            } catch (error) {
                this.errors.push({
                    component: 'URL Validation',
                    issue: `${name} é uma URL inválida: ${url}`,
                    solution: 'Configure uma URL válida (deve começar com http:// ou https://)'
                });
            }
        });
    }

    /**
     * Validar conexão com PostgreSQL
     */
    async validateDatabaseConnection() {
        console.log('🗄️ Validando conexão PostgreSQL...');
        
        try {
            const { Pool } = require('pg');
            
            let config = {};
            
            if (process.env.DATABASE_URL) {
                config.connectionString = process.env.DATABASE_URL;
                config.ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
            } else {
                config.host = process.env.DB_HOST;
                config.port = parseInt(process.env.DB_PORT) || 5432;
                config.user = process.env.DB_USER;
                config.password = process.env.DB_PASSWORD;
                config.database = process.env.DB_NAME;
            }
            
            const pool = new Pool(config);
            
            // Testar conexão
            const client = await pool.connect();
            const result = await client.query('SELECT NOW() as current_time, version() as version');
            client.release();
            await pool.end();
            
            this.info.push('✅ Conexão PostgreSQL bem-sucedida');
            this.info.push(`📅 Data/Hora do servidor: ${result.rows[0].current_time}`);
            this.info.push(`📊 Versão PostgreSQL: ${result.rows[0].version.split(',')[0]}`);
            
        } catch (error) {
            this.errors.push({
                component: 'PostgreSQL Connection',
                issue: `Falha na conexão: ${error.message}`,
                solution: 'Verifique se PostgreSQL está rodando e se as credenciais estão corretas'
            });
        }
    }

    /**
     * Validar Evolution API
     */
    async validateEvolutionApi() {
        console.log('📱 Validando Evolution API...');
        
        if (!process.env.EVOLUTION_API_URL) {
            return; // Já validado em validateEnvironmentVariables
        }
        
        const baseURL = process.env.EVOLUTION_API_URL;
        const possibleEndpoints = [
            '/instance/connectionState',
            '/instance/connect',
            '/instance/fetchInstances',
            '/instance/status'
        ];
        
        const testInstance = 'GABY01';
        const testApikey = '1CEBB8703497-4F31-B33F-335A4233D2FE';
        
        let workingEndpoint = null;
        
        for (const endpoint of possibleEndpoints) {
            try {
                console.log(`   Testando: ${endpoint}/${testInstance}`);
                
                const response = await axios.get(`${baseURL}${endpoint}/${testInstance}`, {
                    timeout: 10000,
                    headers: { 'apikey': testApikey }
                });
                
                if (response.status === 200) {
                    workingEndpoint = endpoint;
                    this.info.push(`✅ Evolution API respondendo em: ${endpoint}`);
                    this.info.push(`📋 Resposta de exemplo: ${JSON.stringify(response.data).substring(0, 100)}...`);
                    break;
                }
                
            } catch (error) {
                const status = error.response?.status;
                if (status === 404) {
                    this.info.push(`❌ Endpoint ${endpoint} não existe`);
                } else if (status === 401 || status === 403) {
                    this.warnings.push({
                        component: 'Evolution API',
                        issue: `Endpoint ${endpoint} retornou ${status} (erro de autorização)`,
                        solution: 'Verifique se as apikeys das instâncias estão corretas'
                    });
                } else {
                    this.info.push(`⚠️ Endpoint ${endpoint} falhou: ${error.message}`);
                }
            }
        }
        
        if (!workingEndpoint) {
            this.errors.push({
                component: 'Evolution API',
                issue: 'Nenhum endpoint funcional encontrado',
                solution: 'Verifique se a Evolution API está rodando e acessível'
            });
        }
    }

    /**
     * Validar webhook N8N
     */
    async validateN8nWebhook() {
        console.log('🎯 Validando webhook N8N...');
        
        if (!process.env.N8N_WEBHOOK_URL) {
            return; // Já validado em validateEnvironmentVariables
        }
        
        try {
            const testPayload = {
                event_type: 'system_test',
                produto: 'TEST',
                instancia: 'SYSTEM',
                evento_origem: 'validation',
                cliente: {
                    nome: 'Sistema',
                    telefone: '5511999999999'
                },
                teste: true,
                timestamp: new Date().toISOString()
            };
            
            console.log('   Enviando payload de teste...');
            
            const response = await axios.post(process.env.N8N_WEBHOOK_URL, testPayload, {
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Cerebro-SystemValidator/1.0'
                }
            });
            
            if (response.status === 200 || response.status === 201) {
                this.info.push('✅ Webhook N8N respondendo corretamente');
                this.info.push(`📊 Status: ${response.status}`);
                
                if (response.data) {
                    this.info.push(`📋 Resposta: ${JSON.stringify(response.data).substring(0, 100)}...`);
                }
            }
            
        } catch (error) {
            const status = error.response?.status;
            const message = error.response?.data?.message || error.message;
            
            if (status === 404) {
                this.errors.push({
                    component: 'N8N Webhook',
                    issue: 'Webhook não encontrado (404)',
                    solution: 'Verifique se a URL do webhook está correta e se o workflow N8N está ativo'
                });
            } else if (status >= 400 && status < 500) {
                this.warnings.push({
                    component: 'N8N Webhook',
                    issue: `Webhook retornou ${status}: ${message}`,
                    solution: 'Verifique a configuração do webhook no N8N'
                });
            } else {
                this.warnings.push({
                    component: 'N8N Webhook',
                    issue: `Erro na conexão: ${message}`,
                    solution: 'Verifique se o N8N está acessível e se a URL está correta'
                });
            }
        }
    }

    /**
     * Imprimir resultados da validação
     */
    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RESULTADO DA VALIDAÇÃO');
        console.log('='.repeat(60));
        
        if (this.info.length > 0) {
            console.log('\n✅ INFORMAÇÕES:');
            this.info.forEach(info => console.log(`   ${info}`));
        }
        
        if (this.warnings.length > 0) {
            console.log('\n⚠️ AVISOS:');
            this.warnings.forEach(warning => {
                console.log(`   ${warning.component}: ${warning.issue}`);
                console.log(`      💡 ${warning.solution}`);
            });
        }
        
        if (this.errors.length > 0) {
            console.log('\n❌ ERROS CRÍTICOS:');
            this.errors.forEach(error => {
                console.log(`   ${error.component}: ${error.issue}`);
                console.log(`      🔧 ${error.solution}`);
            });
        }
        
        console.log('\n' + '='.repeat(60));
        
        if (this.errors.length === 0) {
            console.log('🎉 VALIDAÇÃO CONCLUÍDA COM SUCESSO!');
            console.log('✅ Sistema pronto para iniciar');
            
            if (this.warnings.length > 0) {
                console.log(`⚠️ ${this.warnings.length} aviso(s) encontrado(s) - sistema pode funcionar`);
            }
            
            console.log('\n🚀 Para iniciar o sistema: npm start');
            console.log('📊 Dashboard estará em: http://localhost:' + (process.env.PORT || '3000'));
            console.log('🧪 Testes em: http://localhost:' + (process.env.PORT || '3000') + '/test');
            console.log('🔍 Diagnóstico em: http://localhost:' + (process.env.PORT || '3000') + '/diagnostics');
        } else {
            console.log('❌ VALIDAÇÃO FALHOU!');
            console.log(`🔥 ${this.errors.length} erro(s) crítico(s) devem ser corrigidos antes de iniciar`);
            
            console.log('\n🔧 PRÓXIMOS PASSOS:');
            console.log('1. Corrija todos os erros listados acima');
            console.log('2. Execute novamente: node system-validator.js');
            console.log('3. Após validação OK, inicie: npm start');
        }
        
        console.log('='.repeat(60) + '\n');
    }
}

// Executar validação se chamado diretamente
if (require.main === module) {
    const validator = new SystemValidator();
    validator.validate().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error('❌ Erro durante validação:', error.message);
        process.exit(1);
    });
}

module.exports = SystemValidator;
