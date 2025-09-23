# Use an official Node.js 18 image.
FROM node:18-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install all the system dependencies that Chromium needs to run
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \

    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

# Copy your package files
COPY package*.json ./

# Install your project's dependencies (this will also download Chromium via Puppeteer)
RUN npm install

# Copy the rest of your backend application code
COPY . .

# Tell Docker that your app runs on port 5000 (or whatever port you use)
EXPOSE 5000

# The command to start your server
CMD [ "node", "server.js" ]