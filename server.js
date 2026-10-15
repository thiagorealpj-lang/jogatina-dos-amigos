const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, nick }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = [];

    const isAdminDefault = nick.toLowerCase() === 'c0kz';
    
    // Remove duplicados se houver re-conexão rápida
    rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
    rooms[roomId].push({ id: socket.id, nick, isAdmin: isAdminDefault });

    io.to(roomId).emit('user-list', rooms[roomId]);
    socket.to(roomId).emit('user-connected', { peerId: socket.id, nick });

    socket.on('send-chat', (msg) => {
      io.to(roomId).emit('receive-chat', { 
        nick, 
        msg, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
      });
    });

    socket.on('signal', ({ to, signal, type }) => {
      io.to(to).emit('signal', { from: socket.id, signal, type, nick });
    });

    socket.on('make-admin', ({ targetId }) => {
      const user = rooms[roomId]?.find(u => u.id === targetId);
      if (user) {
        user.isAdmin = true;
        io.to(roomId).emit('user-list', rooms[roomId]);
      }
    });

    // SISTEMA DE KICK E BAN DIRETO
    socket.on('kick-user', ({ targetId }) => {
      // Envia o aviso diretamente para o socket ID do alvo
      io.to(targetId).emit('kicked');
    });

    socket.on('ban-user', ({ targetId }) => {
      io.to(targetId).emit('banned', { targetNick: rooms[roomId]?.find(u => u.id === targetId)?.nick });
    });

    socket.on('disconnect', () => {
      if (rooms[roomId]) {
        rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
        io.to(roomId).emit('user-list', rooms[roomId]);
        socket.to(roomId).emit('user-disconnected', socket.id);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jogatina Dos Amigos rodando na porta ${PORT}`));
