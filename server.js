
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const OWNER_NICK = (process.env.OWNER_NICK || 'c0kz')
  .trim()
  .toLowerCase();

const BAN_FILE = path.join(__dirname, 'banned-users.json');

const rooms = { Geral: [] };
const bannedUsers = new Set();

try {
  if (fs.existsSync(BAN_FILE)) {
    const savedBans = JSON.parse(
      fs.readFileSync(BAN_FILE, 'utf8')
    );

    if (Array.isArray(savedBans)) {
      savedBans.forEach(nick => {
        bannedUsers.add(String(nick).toLowerCase());
      });
    }
  }
} catch (error) {
  console.error('Erro ao carregar banimentos:', error.message);
}

function saveBans() {
  try {
    fs.writeFileSync(
      BAN_FILE,
      JSON.stringify([...bannedUsers], null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Erro ao salvar banimentos:', error.message);
  }
}

function isOwner(socket) {
  return String(socket.data.nick || '').trim().toLowerCase()
    === OWNER_NICK;
}

function isAdmin(socket) {
  return isOwner(socket) || socket.data.isAdmin === true;
}

function findUser(userId) {
  for (const roomName of Object.keys(rooms)) {
    const user = rooms[roomName].find(u => u.id === userId);

    if (user) {
      return { user, roomName };
    }
  }

  return null;
}

function broadcastRoomsState() {
  const summary = {};

  for (const [roomName, users] of Object.entries(rooms)) {
    summary[roomName] = users.map(user => ({
      id: user.id,
      nick: user.nick,
      isAdmin: user.isAdmin,
      isOwner: user.nick.toLowerCase() === OWNER_NICK
    }));
  }

  io.emit('update-all-rooms', summary);
}

function publishRoom(roomName) {
  io.to(roomName).emit('user-list', rooms[roomName] || []);
  broadcastRoomsState();
}

function removeFromRoom(socket) {
  const oldRoom = socket.data.currentRoom;

  if (!oldRoom) return;

  if (rooms[oldRoom]) {
    rooms[oldRoom] = rooms[oldRoom].filter(
      user => user.id !== socket.id
    );

    io.to(oldRoom).emit('user-list', rooms[oldRoom]);
    socket.to(oldRoom).emit('user-disconnected', socket.id);

    if (rooms[oldRoom].length === 0 && oldRoom !== 'Geral') {
      delete rooms[oldRoom];
    }
  }

  socket.leave(oldRoom);
  socket.data.currentRoom = null;

  broadcastRoomsState();
}

function joinRoom(socket, roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = [];
  }

  socket.join(roomName);
  socket.data.currentRoom = roomName;

  const user = {
    id: socket.id,
    nick: socket.data.nick,
    isAdmin: isAdmin(socket)
  };

  rooms[roomName] = rooms[roomName].filter(
    existing => existing.id !== socket.id
  );

  rooms[roomName].push(user);

  publishRoom(roomName);

  socket.to(roomName).emit('user-connected', {
    peerId: socket.id,
    nick: socket.data.nick
  });

  socket.emit('switched-room-success', roomName);
}

function disconnectUser(socket, eventName, message) {
  socket.emit(eventName, { message });

  removeFromRoom(socket);

  // Dá tempo para o evento chegar ao navegador antes da desconexão.
  setTimeout(() => {
    const connectedSocket = io.sockets.sockets.get(socket.id);

    if (connectedSocket) {
      connectedSocket.disconnect(true);
    }
  }, 300);
}

io.on('connection', socket => {
  socket.data.nick = null;
  socket.data.isAdmin = false;
  socket.data.currentRoom = null;

  // ENTRAR NO SERVIDOR
  socket.on('join-room', payload => {
    if (socket.data.nick) return;

    const nick = String(payload?.nick || '').trim().slice(0, 32);
    const roomName = String(payload?.roomId || 'Geral')
      .trim()
      .slice(0, 64) || 'Geral';

    if (!nick) {
      socket.emit('app-error', 'Informe um nick válido.');
      return;
    }

    if (bannedUsers.has(nick.toLowerCase())) {
      socket.emit('banned', {
        message: 'Você foi banido deste servidor.'
      });

      setTimeout(() => socket.disconnect(true), 300);
      return;
    }

    socket.data.nick = nick;
    socket.data.isAdmin = nick.toLowerCase() === OWNER_NICK;

    joinRoom(socket, roomName);
  });

  // CRIAR CANAL
  socket.on('create-room', payload => {
    if (!socket.data.nick) return;

    const roomName = String(payload?.newRoomName || '')
      .trim()
      .slice(0, 64);

    if (!roomName) return;

    if (!rooms[roomName]) {
      rooms[roomName] = [];
      broadcastRoomsState();
    }
  });

  // TROCAR DE CANAL
  socket.on('switch-room', payload => {
    if (!socket.data.nick) return;

    const destination = String(payload?.newRoomId || '')
      .trim()
      .slice(0, 64);

    if (!destination || !rooms[destination]) {
      socket.emit('app-error', 'O canal de destino não existe.');
      return;
    }

    if (destination === socket.data.currentRoom) {
      socket.emit('switched-room-success', destination);
      return;
    }

    removeFromRoom(socket);
    joinRoom(socket, destination);
  });

  // CHAT
  socket.on('send-chat', message => {
    if (!socket.data.currentRoom) return;
    if (typeof message !== 'string') return;

    const msg = message.trim().slice(0, 1000);
    if (!msg) return;

    io.to(socket.data.currentRoom).emit('receive-chat', {
      nick: socket.data.nick,
      msg,
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    });
  });

  // SINALIZAÇÃO WEBRTC
  socket.on('signal', payload => {
    if (!socket.data.nick || !payload?.to || !payload?.signal) {
      return;
    }

    io.to(payload.to).emit('signal', {
      from: socket.id,
      signal: payload.signal,
      type: payload.type,
      nick: socket.data.nick
    });
  });

  // TORNAR ADMIN — SOMENTE O DONO
  socket.on('make-admin', ({ targetId } = {}) => {
    if (!isOwner(socket)) {
      socket.emit(
        'app-error',
        'Somente o dono pode promover administradores.'
      );
      return;
    }

    if (!targetId || targetId === socket.id) return;

    const result = findUser(targetId);
    if (!result) {
      socket.emit('app-error', 'Usuário não encontrado.');
      return;
    }

    if (result.user.nick.toLowerCase() === OWNER_NICK) return;

    result.user.isAdmin = true;

    const targetSocket = io.sockets.sockets.get(targetId);

    if (targetSocket) {
      targetSocket.data.isAdmin = true;
    }

    publishRoom(result.roomName);
  });

  // MOVER USUÁRIO PARA OUTRO CANAL
  socket.on('move-user', ({ targetId, destinationRoom } = {}) => {
    if (!isAdmin(socket)) {
      socket.emit(
        'app-error',
        'Você não tem permissão para mover usuários.'
      );
      return;
    }

    if (!targetId || targetId === socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!targetSocket || !targetSocket.data.currentRoom) {
      socket.emit('app-error', 'Usuário não encontrado ou desconectado.');
      return;
    }

    if (targetSocket.data.nick.toLowerCase() === OWNER_NICK) {
      socket.emit('app-error', 'O dono não pode ser movido.');
      return;
    }

    const destination = String(destinationRoom || '').trim();

    if (!destination || !rooms[destination]) {
      socket.emit('app-error', 'O canal de destino não existe.');
      return;
    }

    if (destination === targetSocket.data.currentRoom) {
      socket.emit('app-error', 'O usuário já está nesse canal.');
      return;
    }

    removeFromRoom(targetSocket);
    joinRoom(targetSocket, destination);

    targetSocket.emit('force-move', {
      destinationRoom: destination
    });
  });

  // EXPULSAR USUÁRIO
  socket.on('kick-user', ({ targetId } = {}) => {
    if (!isAdmin(socket)) {
      socket.emit(
        'app-error',
        'Você não tem permissão para expulsar usuários.'
      );
      return;
    }

    if (!targetId || targetId === socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!targetSocket || !targetSocket.data.currentRoom) {
      socket.emit('app-error', 'Usuário não encontrado ou desconectado.');
      return;
    }

    if (targetSocket.data.nick.toLowerCase() === OWNER_NICK) {
      socket.emit('app-error', 'O dono não pode ser expulso.');
      return;
    }

    disconnectUser(
      targetSocket,
      'kicked',
      'Você foi expulso do servidor.'
    );
  });

  // BANIR USUÁRIO — SOMENTE O DONO
  socket.on('ban-user', ({ targetId } = {}) => {
    if (!isOwner(socket)) {
      socket.emit(
        'app-error',
        'Somente o dono pode banir usuários.'
      );
      return;
    }

    if (!targetId || targetId === socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!targetSocket || !targetSocket.data.currentRoom) {
      socket.emit('app-error', 'Usuário não encontrado ou desconectado.');
      return;
    }

    const targetNick = String(targetSocket.data.nick || '')
      .trim()
      .toLowerCase();

    if (!targetNick || targetNick === OWNER_NICK) {
      socket.emit('app-error', 'Esse usuário não pode ser banido.');
      return;
    }

    bannedUsers.add(targetNick);
    saveBans();

    disconnectUser(
      targetSocket,
      'banned',
      'Você foi banido deste servidor.'
    );
  });

  // DESCONECTAR
  socket.on('disconnect', () => {
    removeFromRoom(socket);
    broadcastRoomsState();
  });
});

server.listen(PORT, () => {
  console.log(`Jogatina Dos Amigos rodando na porta ${PORT}`);
});
