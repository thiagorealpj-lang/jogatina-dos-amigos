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

// Armazena as salas e os objetos completos dos utilizadores em cada uma
const rooms = {
  "Geral": []
};

function broadcastRoomsState() {
  // Envia um resumo de quem está em cada sala para todos os clientes
  const roomsSummary = {};
  for (const [roomName, users] of Object.entries(rooms)) {
    roomsSummary[roomName] = users.map(u => ({ id: u.id, nick: u.nick, isAdmin: u.isAdmin }));
  }
  io.emit('update-all-rooms', roomsSummary);
}

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
    
    rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
    rooms[roomId].push({ id: socket.id, nick, isAdmin: isAdminDefault });

    broadcastRoomsState();
    io.to(roomId).emit('user-list', rooms[roomId]);
    socket.to(roomId).emit('user-connected', { peerId: socket.id, nick });

    socket.on('create-room', ({ newRoomName }) => {
      newRoomName = newRoomName.trim();
      if (newRoomName && !rooms[newRoomName]) {
        rooms[newRoomName] = [];
        broadcastRoomsState();
      }
    });

    socket.on('switch-room', ({ newRoomId }) => {
      if (!rooms[newRoomId]) return;

      socket.leave(currentRoom);
      if (rooms[currentRoom]) {
        rooms[currentRoom] = rooms[currentRoom].filter(u => u.id !== socket.id);
        io.to(currentRoom).emit('user-list', rooms[currentRoom]);
        socket.to(currentRoom).emit('user-disconnected', socket.id);
      }

      currentRoom = newRoomId;
      socket.join(newRoomId);
      
      const wasAdmin = rooms[newRoomId].find(u => u.id === socket.id)?.isAdmin || currentUserNick.toLowerCase() === 'c0kz';
      rooms[newRoomId] = rooms[newRoomId].filter(u => u.id !== socket.id);
      rooms[newRoomId].push({ id: socket.id, nick: currentUserNick, isAdmin: wasAdmin });

      broadcastRoomsState();
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
      for (const rName in rooms) {
        const user = rooms[rName].find(u => u.id === targetId);
        if (user) {
          user.isAdmin = true;
          io.to(rName).emit('user-list', rooms[rName]);
        }
      }
      broadcastRoomsState();
    });

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
        broadcastRoomsState();
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jogatina Dos Amigos rodando na porta ${PORT}`));
