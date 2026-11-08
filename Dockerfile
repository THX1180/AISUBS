FROM node:18-alpine

# Stel werkmap in
WORKDIR /app

# Installeer dependencies eerst voor Docker cache optimalisatie
COPY package*.json ./
RUN npm install --omit=dev

# Kopieer overige applicatiecode
COPY . .

# Hugging Face Spaces vereist poort 7860
ENV PORT=7860
EXPOSE 7860

# Start de add-on
CMD ["node", "server.js"]