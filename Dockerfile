# Dockerfile para despliegue en Render
FROM node:20-alpine

WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production

# Copiar código fuente
COPY . .

# Puerto por defecto expuesto
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
