-- CÉREBRO DE ATENDIMENTO v3.2 - MIGRAÇÕES CORRIGIDAS DO BANCO DE DADOS
-- Execute este arquivo diretamente no PostgreSQL se necessário

-- PRIMEIRO: Limpar eventos final_check se existirem
DELETE FROM events_queue WHERE event_type = 'final_check';

-- Criar tabela de leads (sticky session por cliente) - CORRIGIDA
DROP TABLE IF EXISTS leads CASCADE;
CREATE TABLE leads (
    phone VARCHAR(20) PRIMARY KEY,
    instance_name VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Novos campos para melhor rastreamento
    first_contact_date DATE DEFAULT CURRENT_DATE,
    total_conversations INTEGER DEFAULT 0,
    last_conversation_date TIMESTAMP
);

-- Criar tabela de conversas - CORRIGIDA
DROP TABLE IF EXISTS conversations CASCADE;
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    order_code VARCHAR(50) UNIQUE NOT NULL,
    product VARCHAR(10),
    status VARCHAR(20) DEFAULT 'pix_pending', -- 'pix_pending', 'approved', 'completed', 'timeout', 'convertido'
    current_step INTEGER DEFAULT 0,
    responses_count INTEGER DEFAULT 0,
    instance_name VARCHAR(10),
    amount DECIMAL(10,2) DEFAULT 0,
    pix_url TEXT,
    client_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Novos campos para controle melhorado
    last_response_at TIMESTAMP,
    conversion_response INTEGER, -- qual resposta gerou conversão
    phone_normalized VARCHAR(20), -- telefone já normalizado
    
    -- Índices de performance
    CONSTRAINT valid_status CHECK (status IN ('pix_pending', 'approved', 'completed', 'timeout', 'convertido')),
    CONSTRAINT valid_product CHECK (product IN ('FAB', 'NAT', 'CS', 'UNKNOWN'))
);

-- Criar tabela de mensagens - CORRIGIDA
DROP TABLE IF EXISTS messages CASCADE;
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'sent', 'received', 'system_event', 'n8n_sent'
    content TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'failed', 'duplicate', 'ignored'
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Novos campos para controle
    response_number INTEGER, -- para respostas do cliente (1, 2, 3)
    is_duplicate BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMP,
    
    CONSTRAINT valid_type CHECK (type IN ('sent', 'received', 'system_event', 'n8n_sent')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'duplicate', 'ignored'))
);

-- Criar tabela de eventos CORRIGIDA (sem final_check)
DROP TABLE IF EXISTS events_queue CASCADE;
CREATE TABLE events_queue (
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
    
    -- Novos campos para melhor controle
    error_message TEXT,
    processing_started_at TIMESTAMP,
    processed_at TIMESTAMP,
    
    -- CONSTRAINT: não permitir final_check
    CONSTRAINT valid_event_type CHECK (event_type != 'final_check'),
    CONSTRAINT event_type_allowed CHECK (event_type IN ('pix_timeout', 'venda_aprovada', 'resposta_01', 'resposta_02', 'resposta_03', 'convertido'))
);

-- Criar tabela de logs do sistema - MELHORADA
DROP TABLE IF EXISTS system_logs CASCADE;
CREATE TABLE system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    meta JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Novos campos
    brazil_time VARCHAR(50),
    process_id INTEGER,
    source VARCHAR(50), -- 'webhook', 'queue', 'evolution', etc
    
    CONSTRAINT valid_level CHECK (level IN ('error', 'warn', 'info', 'debug'))
);

-- ÍNDICES OTIMIZADOS para performance
-- Índices para leads
CREATE INDEX idx_leads_instance ON leads(instance_name);
CREATE INDEX idx_leads_created_at ON leads(created_at);
CREATE INDEX idx_leads_phone_normalized ON leads(phone); -- já é PK mas explícito
CREATE INDEX idx_leads_last_conversation ON leads(last_conversation_date);

-- Índices para conversations
CREATE INDEX idx_conversations_phone ON conversations(phone);
CREATE INDEX idx_conversations_phone_normalized ON conversations(phone_normalized);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_order_code ON conversations(order_code); -- já é UNIQUE mas explícito
CREATE INDEX idx_conversations_instance ON conversations(instance_name);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);
CREATE INDEX idx_conversations_status_active ON conversations(status) WHERE status IN ('pix_pending', 'approved');

-- Índices para messages
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_response_number ON messages(response_number);
CREATE INDEX idx_messages_type_status ON messages(type, status);

-- Índices para events_queue (SEM final_check)
CREATE INDEX idx_events_queue_processed ON events_queue(processed);
CREATE INDEX idx_events_queue_scheduled ON events_queue(scheduled_for);
CREATE INDEX idx_events_queue_event_type ON events_queue(event_type);
CREATE INDEX idx_events_queue_order_code ON events_queue(order_code);
CREATE INDEX idx_events_queue_pending ON events_queue(processed, scheduled_for) WHERE processed = false;
CREATE INDEX idx_events_queue_failed ON events_queue(attempts, max_attempts) WHERE attempts >= max_attempts;

-- Índices para system_logs
CREATE INDEX idx_system_logs_level ON system_logs(level);
CREATE INDEX idx_system_logs_created_at ON system_logs(created_at);
CREATE INDEX idx_system_logs_source ON system_logs(source);
CREATE INDEX idx_system_logs_level_created ON system_logs(level, created_at);

-- FUNÇÕES E TRIGGERS
-- Função para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para updated_at
DROP TRIGGER IF EXISTS update_leads_updated_at ON leads;
CREATE TRIGGER update_leads_updated_at 
    BEFORE UPDATE ON leads 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
CREATE TRIGGER update_conversations_updated_at 
    BEFORE UPDATE ON conversations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- TRIGGER para normalizar telefone automaticamente
CREATE OR REPLACE FUNCTION normalize_phone_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- Normalizar telefone automaticamente ao inserir/atualizar
    NEW.phone_normalized = regexp_replace(NEW.phone, '\D', '', 'g');
    
    -- Se tem 14 dígitos e começa com 55, remover 9 extra se necessário
    IF length(NEW.phone_normalized) = 14 AND substring(NEW.phone_normalized, 1, 2) = '55' THEN
        IF substring(NEW.phone_normalized, 5, 1) = '9' AND substring(NEW.phone_normalized, 6, 1) != '9' THEN
            NEW.phone_normalized = substring(NEW.phone_normalized, 1, 4) || substring(NEW.phone_normalized, 6);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS normalize_conversation_phone ON conversations;
CREATE TRIGGER normalize_conversation_phone 
    BEFORE INSERT OR UPDATE ON conversations 
    FOR EACH ROW EXECUTE FUNCTION normalize_phone_trigger();

-- VIEWS ÚTEIS CORRIGIDAS
-- View para conversas com informações completas
CREATE OR REPLACE VIEW v_conversations_complete AS
SELECT 
    c.id,
    c.phone,
    c.phone_normalized,
    c.order_code,
    c.product,
    c.status,
    c.responses_count,
    c.instance_name,
    c.amount,
    c.client_name,
    c.created_at,
    c.updated_at,
    c.last_response_at,
    c.conversion_response,
    l.instance_name as lead_instance,
    COUNT(m.id) as total_messages,
    COUNT(m.id) FILTER (WHERE m.type = 'sent') as sent_messages,
    COUNT(m.id) FILTER (WHERE m.type = 'received') as received_messages,
    COUNT(m.id) FILTER (WHERE m.status = 'duplicate') as duplicate_messages,
    MAX(m.created_at) FILTER (WHERE m.type = 'received') as last_client_message,
    MAX(m.created_at) FILTER (WHERE m.type = 'sent') as last_system_message
FROM conversations c
LEFT JOIN leads l ON c.phone = l.phone
LEFT JOIN messages m ON c.id = m.conversation_id
GROUP BY c.id, c.phone, c.phone_normalized, c.order_code, c.product, c.status, 
         c.responses_count, c.instance_name, c.amount, c.client_name, 
         c.created_at, c.updated_at, c.last_response_at, c.conversion_response, l.instance_name;

-- View para estatísticas por instância MELHORADA
CREATE OR REPLACE VIEW v_instance_stats_detailed AS
SELECT 
    l.instance_name,
    COUNT(*) as total_leads,
    COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '24 hours') as leads_last_24h,
    COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '7 days') as leads_last_7d,
    COUNT(*) FILTER (WHERE l.created_at >= NOW() - INTERVAL '30 days') as leads_last_30d,
    MIN(l.created_at) as first_lead,
    MAX(l.created_at) as last_lead,
    
    -- Estatísticas de conversas
    COUNT(c.id) as total_conversations,
    COUNT(c.id) FILTER (WHERE c.status = 'approved') as approved_conversations,
    COUNT(c.id) FILTER (WHERE c.status = 'completed') as completed_conversations,
    COUNT(c.id) FILTER (WHERE c.status = 'convertido') as converted_conversations,
    COUNT(c.id) FILTER (WHERE c.status = 'timeout') as timeout_conversations,
    
    -- Métricas de engajamento
    AVG(c.responses_count) FILTER (WHERE c.responses_count > 0) as avg_responses,
    SUM(c.amount) as total_revenue,
    AVG(c.amount) as avg_ticket
    
FROM leads l
LEFT JOIN conversations c ON l.phone = c.phone
GROUP BY l.instance_name
ORDER BY total_leads DESC;

-- View para estatísticas de conversas MELHORADA
CREATE OR REPLACE VIEW v_conversation_stats_detailed AS
SELECT 
    status,
    product,
    COUNT(*) as total,
    AVG(responses_count) as avg_responses,
    AVG(amount) as avg_amount,
    SUM(amount) as total_amount,
    MIN(created_at) as first_conversation,
    MAX(created_at) as last_conversation,
    
    -- Estatísticas por período
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as last_24h,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_7d,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as last_30d,
    
    -- Estatísticas de conversão
    COUNT(*) FILTER (WHERE conversion_response IS NOT NULL) as had_conversion,
    AVG(conversion_response) FILTER (WHERE conversion_response IS NOT NULL) as avg_conversion_response
    
FROM conversations
GROUP BY status, product
ORDER BY status, product;

-- FUNÇÕES UTILITÁRIAS CORRIGIDAS

-- Função para limpeza automática MELHORADA
CREATE OR REPLACE FUNCTION cleanup_old_data_v2(retention_days INTEGER DEFAULT 30)
RETURNS TABLE (
    deleted_conversations INTEGER,
    deleted_messages INTEGER,
    deleted_events INTEGER,
    deleted_logs INTEGER,
    deleted_final_check INTEGER
) AS $$
DECLARE
    cutoff_date TIMESTAMP;
    conv_count INTEGER;
    msg_count INTEGER;
    event_count INTEGER;
    log_count INTEGER;
    final_check_count INTEGER;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
    
    -- Deletar conversas completadas antigas
    DELETE FROM conversations 
    WHERE status IN ('completed', 'timeout', 'convertido') 
    AND updated_at < cutoff_date;
    GET DIAGNOSTICS conv_count = ROW_COUNT;
    
    -- Contar mensagens órfãs antes de remover
    SELECT COUNT(*) INTO msg_count 
    FROM messages m 
    LEFT JOIN conversations c ON m.conversation_id = c.id 
    WHERE c.id IS NULL;
    
    -- Deletar mensagens órfãs
    DELETE FROM messages m 
    WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.id = m.conversation_id
    );
    
    -- Deletar eventos processados antigos
    DELETE FROM events_queue 
    WHERE processed = TRUE 
    AND created_at < cutoff_date;
    GET DIAGNOSTICS event_count = ROW_COUNT;
    
    -- IMPORTANTE: Deletar TODOS os eventos final_check (independente da data)
    DELETE FROM events_queue WHERE event_type = 'final_check';
    GET DIAGNOSTICS final_check_count = ROW_COUNT;
    
    -- Deletar logs antigos
    DELETE FROM system_logs 
    WHERE created_at < cutoff_date;
    GET DIAGNOSTICS log_count = ROW_COUNT;
    
    RETURN QUERY SELECT conv_count, msg_count, event_count, log_count, final_check_count;
END;
$$ LANGUAGE plpgsql;

-- Função para obter estatísticas COMPLETAS
CREATE OR REPLACE FUNCTION get_system_stats_v2()
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'timestamp', NOW(),
        'brazil_time', to_char(NOW() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
        'version', '3.2-MEGA-CORRECTED',
        
        -- Estatísticas básicas
        'total_leads', (SELECT COUNT(*) FROM leads),
        'active_conversations', (SELECT COUNT(*) FROM conversations WHERE status IN ('pix_pending', 'approved')),
        'pending_pix', (SELECT COUNT(*) FROM conversations WHERE status = 'pix_pending'),
        'approved_sales', (SELECT COUNT(*) FROM conversations WHERE status IN ('approved', 'completed')),
        'converted_sales', (SELECT COUNT(*) FROM conversations WHERE status = 'convertido'),
        'timeout_sales', (SELECT COUNT(*) FROM conversations WHERE status = 'timeout'),
        'total_messages', (SELECT COUNT(*) FROM messages),
        'queued_events', (SELECT COUNT(*) FROM events_queue WHERE processed = FALSE),
        'failed_events', (SELECT COUNT(*) FROM events_queue WHERE attempts >= max_attempts),
        
        -- Distribuição por instância
        'by_instance', (
            SELECT json_object_agg(instance_name, stats)
            FROM (
                SELECT 
                    instance_name,
                    json_build_object(
                        'total_leads', total_leads,
                        'last_24h', leads_last_24h,
                        'last_7d', leads_last_7d,
                        'conversations', total_conversations,
                        'revenue', COALESCE(total_revenue, 0)
                    ) as stats
                FROM v_instance_stats_detailed
            ) t
        ),
        
        -- Estatísticas por produto
        'by_product', (
            SELECT json_object_agg(product, stats)
            FROM (
                SELECT 
                    product,
                    json_build_object(
                        'total', COUNT(*),
                        'approved', COUNT(*) FILTER (WHERE status IN ('approved', 'completed')),
                        'converted', COUNT(*) FILTER (WHERE status = 'convertido'),
                        'timeout', COUNT(*) FILTER (WHERE status = 'timeout'),
                        'avg_amount', ROUND(AVG(amount), 2),
                        'total_revenue', ROUND(SUM(amount), 2)
                    ) as stats
                FROM conversations 
                WHERE product IS NOT NULL
                GROUP BY product
            ) t
        ),
        
        -- Métricas das últimas 24h
        'last_24h', (
            SELECT json_build_object(
                'new_leads', (SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '24 hours'),
                'new_conversations', (SELECT COUNT(*) FROM conversations WHERE created_at >= NOW() - INTERVAL '24 hours'),
                'sent_messages', (SELECT COUNT(*) FROM messages WHERE type = 'sent' AND created_at >= NOW() - INTERVAL '24 hours'),
                'received_messages', (SELECT COUNT(*) FROM messages WHERE type = 'received' AND created_at >= NOW() - INTERVAL '24 hours'),
                'duplicate_messages', (SELECT COUNT(*) FROM messages WHERE status = 'duplicate' AND created_at >= NOW() - INTERVAL '24 hours'),
                'conversions', (SELECT COUNT(*) FROM conversations WHERE status = 'convertido' AND updated_at >= NOW() - INTERVAL '24 hours')
            )
        ),
        
        -- Métricas de qualidade
        'quality_metrics', (
            SELECT json_build_object(
                'avg_responses_per_conversation', ROUND(AVG(responses_count), 2),
                'conversations_with_responses', COUNT(*) FILTER (WHERE responses_count > 0),
                'duplicate_rate', ROUND(
                    (SELECT COUNT(*) FROM messages WHERE status = 'duplicate')::DECIMAL / 
                    NULLIF((SELECT COUNT(*) FROM messages WHERE type = 'received'), 0) * 100, 2
                ),
                'conversion_rate', ROUND(
                    (SELECT COUNT(*) FROM conversations WHERE status = 'convertido')::DECIMAL / 
                    NULLIF((SELECT COUNT(*) FROM conversations WHERE status != 'pix_pending'), 0) * 100, 2
                )
            )
            FROM conversations
        ),
        
        -- Status da fila
        'queue_health', (
            SELECT json_build_object(
                'total_events', COUNT(*),
                'pending_events', COUNT(*) FILTER (WHERE processed = false),
                'failed_events', COUNT(*) FILTER (WHERE attempts >= max_attempts),
                'pix_timeouts', COUNT(*) FILTER (WHERE event_type = 'pix_timeout'),
                'final_check_events', COUNT(*) FILTER (WHERE event_type = 'final_check'), -- deve ser 0
                'oldest_pending', MIN(created_at) FILTER (WHERE processed = false)
            )
            FROM events_queue
        )
    ) INTO result;
    
    RETURN result;
END;
$ LANGUAGE plpgsql;

-- Função para normalizar telefones existentes
CREATE OR REPLACE FUNCTION fix_existing_phone_numbers()
RETURNS TABLE (
    fixed_leads INTEGER,
    fixed_conversations INTEGER
) AS $
DECLARE
    lead_count INTEGER;
    conv_count INTEGER;
BEGIN
    -- Normalizar telefones na tabela leads
    UPDATE leads SET phone = (
        SELECT CASE
            WHEN length(regexp_replace(phone, '\D', '', 'g')) = 14 
                 AND substring(regexp_replace(phone, '\D', '', 'g'), 1, 2) = '55'
                 AND substring(regexp_replace(phone, '\D', '', 'g'), 5, 1) = '9'
                 AND substring(regexp_replace(phone, '\D', '', 'g'), 6, 1) != '9'
            THEN substring(regexp_replace(phone, '\D', '', 'g'), 1, 4) || substring(regexp_replace(phone, '\D', '', 'g'), 6)
            ELSE regexp_replace(phone, '\D', '', 'g')
        END
    );
    GET DIAGNOSTICS lead_count = ROW_COUNT;
    
    -- Normalizar telefones na tabela conversations
    UPDATE conversations SET 
        phone = (
            SELECT CASE
                WHEN length(regexp_replace(phone, '\D', '', 'g')) = 14 
                     AND substring(regexp_replace(phone, '\D', '', 'g'), 1, 2) = '55'
                     AND substring(regexp_replace(phone, '\D', '', 'g'), 5, 1) = '9'
                     AND substring(regexp_replace(phone, '\D', '', 'g'), 6, 1) != '9'
                THEN substring(regexp_replace(phone, '\D', '', 'g'), 1, 4) || substring(regexp_replace(phone, '\D', '', 'g'), 6)
                ELSE regexp_replace(phone, '\D', '', 'g')
            END
        ),
        phone_normalized = regexp_replace(phone, '\D', '', 'g');
    GET DIAGNOSTICS conv_count = ROW_COUNT;
    
    RETURN QUERY SELECT lead_count, conv_count;
END;
$ LANGUAGE plpgsql;

-- PROCEDURE para manutenção diária
CREATE OR REPLACE FUNCTION daily_maintenance()
RETURNS TABLE (
    action VARCHAR,
    result VARCHAR,
    count INTEGER
) AS $
DECLARE
    cleanup_result RECORD;
BEGIN
    -- 1. Remover eventos final_check
    DELETE FROM events_queue WHERE event_type = 'final_check';
    RETURN QUERY SELECT 'remove_final_check'::VARCHAR, 'success'::VARCHAR, ROW_COUNT;
    
    -- 2. Limpar dados antigos (7 dias)
    SELECT * INTO cleanup_result FROM cleanup_old_data_v2(7);
    RETURN QUERY SELECT 'cleanup_conversations'::VARCHAR, 'success'::VARCHAR, cleanup_result.deleted_conversations;
    RETURN QUERY SELECT 'cleanup_messages'::VARCHAR, 'success'::VARCHAR, cleanup_result.deleted_messages;
    RETURN QUERY SELECT 'cleanup_events'::VARCHAR, 'success'::VARCHAR, cleanup_result.deleted_events;
    RETURN QUERY SELECT 'cleanup_logs'::VARCHAR, 'success'::VARCHAR, cleanup_result.deleted_logs;
    
    -- 3. Atualizar estatísticas das tabelas
    ANALYZE leads;
    ANALYZE conversations;
    ANALYZE messages;
    ANALYZE events_queue;
    ANALYZE system_logs;
    RETURN QUERY SELECT 'analyze_tables'::VARCHAR, 'success'::VARCHAR, 5;
    
    -- 4. Normalizar telefones se necessário
    PERFORM fix_existing_phone_numbers();
    RETURN QUERY SELECT 'normalize_phones'::VARCHAR, 'success'::VARCHAR, 0;
END;
$ LANGUAGE plpgsql;

-- DADOS DE TESTE CORRIGIDOS (apenas para desenvolvimento)
-- REMOVER EM PRODUÇÃO

-- INSERT INTO leads (phone, instance_name) VALUES 
-- ('5511999999999', 'GABY01'),
-- ('5511888888888', 'GABY02'),
-- ('5511777777777', 'GABY01');

-- INSERT INTO conversations (phone, order_code, product, status, instance_name, amount, client_name) VALUES
-- ('5511999999999', 'TEST-001', 'FAB', 'approved', 'GABY01', 297.00, 'João Teste Silva'),
-- ('5511888888888', 'TEST-002', 'NAT', 'pix_pending', 'GABY02', 197.00, 'Maria Teste Santos'),
-- ('5511777777777', 'TEST-003', 'CS', 'convertido', 'GABY01', 97.00, 'Pedro Teste Costa');

-- EXECUTAR LIMPEZA INICIAL
SELECT cleanup_old_data_v2(1); -- Limpar dados de 1+ dia
SELECT fix_existing_phone_numbers(); -- Normalizar telefones existentes

-- VERIFICAÇÕES FINAIS
-- Verificar se não há eventos final_check
SELECT 'final_check_events' as check_name, COUNT(*) as count FROM events_queue WHERE event_type = 'final_check';

-- Verificar integridade das constraints
SELECT 'valid_event_types' as check_name, COUNT(*) as count FROM events_queue WHERE event_type = 'final_check'; -- deve ser 0

-- Verificar índices criados
SELECT 'indexes_created' as check_name, COUNT(*) as count FROM pg_indexes WHERE tablename IN ('leads', 'conversations', 'messages', 'events_queue', 'system_logs');

-- Verificar views criadas  
SELECT 'views_created' as check_name, COUNT(*) as count FROM pg_views WHERE viewname LIKE 'v_%';

-- Verificar functions criadas
SELECT 'functions_created' as check_name, COUNT(*) as count FROM pg_proc WHERE proname IN ('update_updated_at_column', 'normalize_phone_trigger', 'cleanup_old_data_v2', 'get_system_stats_v2', 'fix_existing_phone_numbers', 'daily_maintenance');

-- COMENTÁRIOS FINAIS:

-- ESTRUTURA DAS TABELAS v3.2:
-- 
-- LEADS: Mapeamento phone -> instância com estatísticas
-- CONVERSATIONS: Todas as conversas com status detalhado (SEM referência a final_check)
-- MESSAGES: Log completo de mensagens com controle de duplicatas
-- EVENTS_QUEUE: Fila de eventos SEM suporte a final_check (constraint impede)
-- SYSTEM_LOGS: Logs estruturados com fonte e contexto

-- PRINCIPAIS MELHORIAS:
-- ✅ Constraint que impede criação de eventos final_check
-- ✅ Normalização automática de telefones via trigger
-- ✅ Índices otimizados para queries de alta performance
-- ✅ Views com estatísticas completas e métricas de qualidade
-- ✅ Functions para manutenção automática e limpeza
-- ✅ Campos extras para controle de duplicatas e conversões
-- ✅ Procedure de manutenção diária automatizada

-- COMANDOS ÚTEIS:
-- Para ver estatísticas: SELECT get_system_stats_v2();
-- Para manutenção diária: SELECT * FROM daily_maintenance();
-- Para normalizar telefones: SELECT * FROM fix_existing_phone_numbers();
-- Para limpeza manual: SELECT * FROM cleanup_old_data_v2(30);

-- VERIFICAÇÃO FINAL - deve retornar 0:
SELECT COUNT(*) as final_check_events_remaining FROM events_queue WHERE event_type = 'final_check'; status
        'by_status', (
            SELECT json_object_agg(status, total)
            FROM (
                SELECT status, COUNT(*) as total 
                FROM conversations 
                GROUP BY status
            ) t
        ),
        
        -- Estatísticas por
