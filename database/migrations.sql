-- CÉREBRO DE ATENDIMENTO v3.0 - MIGRAÇÕES DO BANCO DE DADOS
-- Execute este arquivo diretamente no PostgreSQL se necessário

-- Criar tabela de leads (sticky session por cliente)
CREATE TABLE IF NOT EXISTS leads (
    phone VARCHAR(20) PRIMARY KEY,
    instance_name VARCHAR(10) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Criar tabela de conversas
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    order_code VARCHAR(50) UNIQUE NOT NULL,
    product VARCHAR(10),
    status VARCHAR(20) DEFAULT 'pix_pending', -- 'pix_pending', 'approved', 'completed', 'timeout', 'finalized'
    current_step INTEGER DEFAULT 0,
    responses_count INTEGER DEFAULT 0,
    instance_name VARCHAR(10),
    amount DECIMAL(10,2) DEFAULT 0,
    pix_url TEXT,
    client_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Criar tabela de mensagens
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'sent', 'received', 'system_event', 'n8n_sent'
    content TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'failed'
    created_at TIMESTAMP DEFAULT NOW()
);

-- Criar tabela de eventos para reprocessamento
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

-- Criar tabela de logs do sistema
CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    meta JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Criar índices para performance
CREATE INDEX IF NOT EXISTS idx_leads_instance ON leads(instance_name);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_order_code ON conversations(order_code);
CREATE INDEX IF NOT EXISTS idx_conversations_instance ON conversations(instance_name);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE INDEX IF NOT EXISTS idx_events_queue_processed ON events_queue(processed);
CREATE INDEX IF NOT EXISTS idx_events_queue_scheduled ON events_queue(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_events_queue_event_type ON events_queue(event_type);
CREATE INDEX IF NOT EXISTS idx_events_queue_order_code ON events_queue(order_code);

CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);

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

-- Views úteis para relatórios
CREATE OR REPLACE VIEW v_conversations_summary AS
SELECT 
    c.id,
    c.phone,
    c.order_code,
    c.product,
    c.status,
    c.responses_count,
    c.instance_name,
    c.amount,
    c.client_name,
    c.created_at,
    c.updated_at,
    COUNT(m.id) as total_messages,
    COUNT(m.id) FILTER (WHERE m.type = 'sent') as sent_messages,
    COUNT(m.id) FILTER (WHERE m.type = 'received') as received_messages
FROM conversations c
LEFT JOIN messages m ON c.id = m.conversation_id
GROUP BY c.id, c.phone, c.order_code, c.product, c.status, c.responses_count, 
         c.instance_name, c.amount, c.client_name, c.created_at, c.updated_at;

-- View para estatísticas por instância
CREATE OR REPLACE VIEW v_instance_stats AS
SELECT 
    instance_name,
    COUNT(*) as total_leads,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as leads_last_24h,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as leads_last_7d,
    MIN(created_at) as first_lead,
    MAX(created_at) as last_lead
FROM leads
GROUP BY instance_name
ORDER BY total_leads DESC;

-- View para estatísticas de conversas
CREATE OR REPLACE VIEW v_conversation_stats AS
SELECT 
    status,
    product,
    COUNT(*) as total,
    AVG(responses_count) as avg_responses,
    AVG(amount) as avg_amount,
    SUM(amount) as total_amount,
    MIN(created_at) as first_conversation,
    MAX(created_at) as last_conversation
FROM conversations
GROUP BY status, product
ORDER BY status, product;

-- Função para limpeza automática de dados antigos
CREATE OR REPLACE FUNCTION cleanup_old_data(retention_days INTEGER DEFAULT 30)
RETURNS TABLE (
    deleted_conversations INTEGER,
    deleted_messages INTEGER,
    deleted_events INTEGER,
    deleted_logs INTEGER
) AS $$
DECLARE
    cutoff_date TIMESTAMP;
    conv_count INTEGER;
    msg_count INTEGER;
    event_count INTEGER;
    log_count INTEGER;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
    
    -- Deletar conversas completadas antigas
    DELETE FROM conversations 
    WHERE status IN ('completed', 'finalized', 'timeout') 
    AND updated_at < cutoff_date;
    GET DIAGNOSTICS conv_count = ROW_COUNT;
    
    -- Deletar mensagens órfãs (referências já removidas por CASCADE)
    -- Mas vamos contar as que foram removidas
    SELECT COUNT(*) INTO msg_count 
    FROM messages m 
    LEFT JOIN conversations c ON m.conversation_id = c.id 
    WHERE c.id IS NULL;
    
    DELETE FROM messages m 
    WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.id = m.conversation_id
    );
    
    -- Deletar eventos processados antigos
    DELETE FROM events_queue 
    WHERE processed = TRUE 
    AND created_at < cutoff_date;
    GET DIAGNOSTICS event_count = ROW_COUNT;
    
    -- Deletar logs antigos
    DELETE FROM system_logs 
    WHERE created_at < cutoff_date;
    GET DIAGNOSTICS log_count = ROW_COUNT;
    
    RETURN QUERY SELECT conv_count, msg_count, event_count, log_count;
END;
$$ LANGUAGE plpgsql;

-- Função para obter estatísticas gerais
CREATE OR REPLACE FUNCTION get_system_stats()
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'total_leads', (SELECT COUNT(*) FROM leads),
        'active_conversations', (SELECT COUNT(*) FROM conversations WHERE status IN ('pix_pending', 'approved')),
        'pending_pix', (SELECT COUNT(*) FROM conversations WHERE status = 'pix_pending'),
        'approved_sales', (SELECT COUNT(*) FROM conversations WHERE status IN ('approved', 'completed')),
        'total_messages', (SELECT COUNT(*) FROM messages),
        'queued_events', (SELECT COUNT(*) FROM events_queue WHERE processed = FALSE),
        'by_instance', (
            SELECT json_object_agg(instance_name, total_leads)
            FROM v_instance_stats
        ),
        'by_status', (
            SELECT json_object_agg(status, total)
            FROM (
                SELECT status, COUNT(*) as total 
                FROM conversations 
                GROUP BY status
            ) t
        ),
        'last_24h', (
            SELECT json_build_object(
                'new_leads', (SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '24 hours'),
                'new_conversations', (SELECT COUNT(*) FROM conversations WHERE created_at >= NOW() - INTERVAL '24 hours'),
                'sent_messages', (SELECT COUNT(*) FROM messages WHERE type = 'sent' AND created_at >= NOW() - INTERVAL '24 hours'),
                'received_messages', (SELECT COUNT(*) FROM messages WHERE type = 'received' AND created_at >= NOW() - INTERVAL '24 hours')
            )
        )
    ) INTO result;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Inserir dados de exemplo para teste (REMOVER EM PRODUÇÃO)
-- INSERT INTO leads (phone, instance_name) VALUES 
-- ('5511999999999', 'GABY01'),
-- ('5511888888888', 'GABY02'),
-- ('5511777777777', 'GABY01');

-- Comentários sobre as tabelas:
-- 
-- LEADS: Armazena mapeamento phone -> instância (sticky session)
-- CONVERSATIONS: Armazena todas as conversas ativas e históricas
-- MESSAGES: Log de todas as mensagens (enviadas/recebidas)
-- EVENTS_QUEUE: Fila de eventos com timeout/retry
-- SYSTEM_LOGS: Logs estruturados do sistema

-- Para verificar se tudo foi criado corretamente:
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
