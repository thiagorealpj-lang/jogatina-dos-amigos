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

// Estrutura de salas do servidor estilo Discord (Ex: "Geral" já vem criada por defeito)
const rooms = {
  "Geral": []
};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserNick = null;

  socket.on('join-room', ({ roomId, nick }) => {
    roomId = roomId.trim() || "Geral";
    if (!rooms[roomId]) rooms[roomId] = [];

    currentRoom = roomId;
    currentUserNick = nick;

    socket.join(roomId);

    const isAdminDefault = nick.toLowerCase() === 'c0kz';
    
    // Remove duplicados e adiciona o utilizador
    rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
    rooms[roomId].push({ id: socket.id, nick, isAdmin: isAdminDefault });

    // Enviar lista atualizada de salas e utilizadores da sala atual
    io.emit('rooms-list', Object.keys(rooms));
    io.to(roomId).emit('user-list', rooms[roomId]);
    socket.to(roomId).emit('user-connected', { peerId: socket.id, nick });

    // Criar nova sala / canal
    socket.on('create-room', ({ newRoomName }) => {
      newRoomName = newRoomName.trim();
      if (newRoomName && !rooms[newRoomName]) {
        rooms[newRoomName] = [];
        io.emit('rooms-list', Object.keys(rooms));
      }
    });

    // Mudar de sala (clicar em canal diferente)
    socket.on('switch-room', ({ newRoomId }) => {
      if (!rooms[newRoomId]) return;

      // Sai da sala anterior
      socket.leave(currentRoom);
      if (rooms[currentRoom]) {
        rooms[currentRoom] = rooms[currentRoom].filter(u => u.id !== socket.id);
        io.to(currentRoom).emit('user-list', rooms[currentRoom]);
        socket.to(currentRoom).emit('user-disconnected', socket.id);
      }

      // Entra na nova sala
      currentRoom = newRoomId;
      socket.join(newRoomId);
      rooms[newRoomId].push({ id: socket.id, nick: currentUserNick, isAdmin: isAdminDefault });

      io.to(newRoomId).emit('user-list', rooms[newRoomId]);
      socket.to(newRoomId).emit('user-connected', { peerId: socket.id, nick: currentUserNick });
      socket.emit('switched-room-success', newRoomId);
    });

    socket.on('send-chat', (msg) => {
      io.to(currentRoom).emit('receive-chat', { 
        nick, 
        msg, 
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
      });
    });

    socket.on('signal', ({ to, signal, type }) => {
      io.to(to).emit('signal', { from: socket.id, signal, type, nick });
    });

    socket.on('make-admin', ({ targetId }) => {
      const user = rooms[currentRoom]?.find(u => u.id === targetId);
      if (user) {
        user.isAdmin = true;
        io.to(currentRoom).emit('user-list', rooms[currentRoom]);
      }
    });

    // Mover utilizador para outra sala (Admin/Dono)
    socket.on('move-user', ({ targetId, destinationRoom }) => {
      io.to(targetId).emit('force-move', { destinationRoom });
    });

    socket.on('kick-user', ({ targetId }) => {
      io.to(targetId).emit('kicked');
    });

    socket.on('ban-user', ({ targetId }) => {
      io.to(targetId).emit('banned');
    });

    socket.on('disconnect', () => {
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom] = rooms[currentRoom].filter(u => u.id !== socket.id);
        io.to(currentRoom).emit('user-list', rooms[currentRoom]);
        socket.to(currentRoom).emit('user-disconnected', socket.id);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jogatina Dos Amigos rodando na porta ${PORT}`));
