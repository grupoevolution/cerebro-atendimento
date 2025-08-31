# Dockerfile para deploy no Easypanel
FROM node:18-alpine

WORKDIR /app

# Instalar dependências do sistema
RUN apk add --no-cache \
    postgresql-client \
    curl

# Copiar package.json primeiro (para cache de layers)
COPY package.json ./

# Instalar dependências npm
RUN npm install --production

# Copiar resto do código
COPY . .

# Criar diretório para logs
RUN mkdir -p logs

# Expor porta
EXPOSE 3000

# Comando de inicialização
CMD ["npm", "start"]
