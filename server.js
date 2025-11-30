const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');
const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const CHAT_FILE = path.join(__dirname, 'chat.json');
const RESET_TOKENS_FILE = path.join(__dirname, 'reset-tokens.json');
const PUSH_SUBSCRIPTIONS_FILE = path.join(__dirname, 'push-subscriptions.json');
const TOURNAMENT_CHAT_FILE = path.join(__dirname, 'tournament-chat.json');

// --- Helper functions for data persistence ---
function readJSON(file, defaultValue = []) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
      return defaultValue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || JSON.stringify(defaultValue));
  } catch (err) {
    console.error(`Error reading ${file}:`, err);
    return defaultValue;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
  }
}

// Initialize data files
readJSON(USERS_FILE, []);
readJSON(EVENTS_FILE, []);
readJSON(TEAMS_FILE, []);
readJSON(TICKETS_FILE, []);
readJSON(CHAT_FILE, []);
readJSON(RESET_TOKENS_FILE, []);
readJSON(PUSH_SUBSCRIPTIONS_FILE, []);
readJSON(TOURNAMENT_CHAT_FILE, []);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'slovak_patriot_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

// Middleware to check if user is admin
function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) {
    next();
  } else {
    res.status(403).json({ ok: false, message: 'Admin access required' });
  }
}

// --- WEBSOCKET CHAT ---
// Map to store clients: userId -> { ws, username, isAdmin, currentRoom }
const chatClients = new Map();

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'auth') {
        // Store client info
        chatClients.set(data.userId, { 
          ws, 
          username: data.username, 
          isAdmin: data.isAdmin,
          isCaptain: data.isCaptain || false,
          teamId: data.teamId || null,
          currentRoom: data.room || 'global' // 'global', 'ticket-{id}', 'tournament-admin', 'team-{id}', 'match-{id}'
        });
        
        // Handle different room types
        if (data.room && data.room.startsWith('ticket-')) {
          const ticketId = data.room.split('-')[1];
          const tickets = readJSON(TICKETS_FILE, []);
          const ticket = tickets.find(t => t.id === ticketId);
          if (ticket) {
             ws.send(JSON.stringify({ type: 'history', messages: ticket.messages || [] }));
          }
        } else if (data.room && data.room.startsWith('tournament-')) {
          // Tournament chat history
          const tournamentChat = readJSON(TOURNAMENT_CHAT_FILE, []);
          const roomMessages = tournamentChat.filter(m => m.room === data.room || m.room === 'tournament-admin');
          ws.send(JSON.stringify({ type: 'history', messages: roomMessages }));
        } else if (data.room && data.room.startsWith('team-')) {
          // Team chat history
          const tournamentChat = readJSON(TOURNAMENT_CHAT_FILE, []);
          const roomMessages = tournamentChat.filter(m => m.room === data.room);
          ws.send(JSON.stringify({ type: 'history', messages: roomMessages }));
        } else if (data.room && data.room.startsWith('match-')) {
          // Match chat history (captain to captain)
          const tournamentChat = readJSON(TOURNAMENT_CHAT_FILE, []);
          const roomMessages = tournamentChat.filter(m => m.room === data.room);
          ws.send(JSON.stringify({ type: 'history', messages: roomMessages }));
        } else {
          // Global chat history
          const chatHistory = readJSON(CHAT_FILE, []);
          ws.send(JSON.stringify({ type: 'history', messages: chatHistory }));
        }

      } else if (data.type === 'message') {
        const chatMessage = {
          id: Date.now().toString(),
          userId: data.userId,
          username: data.username,
          message: data.message,
          isAdmin: data.isAdmin || false,
          isCaptain: data.isCaptain || false,
          teamId: data.teamId || null,
          room: data.room || 'global',
          timestamp: new Date().toISOString()
        };

        const room = data.room || 'global';

        if (room.startsWith('ticket-')) {
          // Handle Ticket Chat
          const ticketId = room.split('-')[1];
          const tickets = readJSON(TICKETS_FILE, []);
          const ticket = tickets.find(t => t.id === ticketId);
          
          if (ticket) {
            ticket.messages = ticket.messages || [];
            ticket.messages.push(chatMessage);
            
            // Update ticket status if needed
            if (data.isAdmin) {
                ticket.hasUnreadResponse = true;
                ticket.responses = ticket.responses || [];
                ticket.responses.push({
                    message: data.message,
                    respondedBy: data.username,
                    respondedAt: new Date().toISOString()
                });
            }
            
            writeJSON(TICKETS_FILE, tickets);

            // Broadcast to clients in this ticket room
            broadcastToRoom(room, { type: 'message', message: chatMessage });
          }

        } else if (room.startsWith('tournament-') || room.startsWith('team-') || room.startsWith('match-')) {
          // Handle Tournament Chat
          const tournamentChat = readJSON(TOURNAMENT_CHAT_FILE, []);
          tournamentChat.push(chatMessage);
          writeJSON(TOURNAMENT_CHAT_FILE, tournamentChat);
          
          // Broadcast based on room type
          if (room === 'tournament-admin') {
            // Admin messages go to all captains and admins
            broadcastToRoom('tournament-admin', { type: 'message', message: chatMessage });
            broadcastToCaptains({ type: 'message', message: chatMessage });
          } else if (room.startsWith('team-')) {
            // Team messages only to team members
            broadcastToRoom(room, { type: 'message', message: chatMessage });
          } else if (room.startsWith('match-')) {
            // Match messages to both team captains and admins
            broadcastToRoom(room, { type: 'message', message: chatMessage });
            broadcastToAdmins({ type: 'message', message: chatMessage });
          }

        } else {
          // Handle Global Chat
          const chatHistory = readJSON(CHAT_FILE, []);
          chatHistory.push(chatMessage);
          writeJSON(CHAT_FILE, chatHistory);
          
          // Broadcast to global room
          broadcastToRoom('global', { type: 'message', message: chatMessage });
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', () => {
    // Remove client from map
    for (const [userId, client] of chatClients.entries()) {
      if (client.ws === ws) {
        chatClients.delete(userId);
        break;
      }
    }
  });
});

// Helper function to broadcast to a specific room
function broadcastToRoom(room, data) {
  wss.clients.forEach(client => {
    let clientInfo = null;
    for (const [uid, info] of chatClients.entries()) {
      if (info.ws === client) {
        clientInfo = info;
        break;
      }
    }
    
    if (client.readyState === WebSocket.OPEN && clientInfo && clientInfo.currentRoom === room) {
      client.send(JSON.stringify(data));
    }
  });
}

// Helper function to broadcast to all captains
function broadcastToCaptains(data) {
  wss.clients.forEach(client => {
    let clientInfo = null;
    for (const [uid, info] of chatClients.entries()) {
      if (info.ws === client) {
        clientInfo = info;
        break;
      }
    }
    
    if (client.readyState === WebSocket.OPEN && clientInfo && clientInfo.isCaptain) {
      client.send(JSON.stringify(data));
    }
  });
}

// Helper function to broadcast to all admins
function broadcastToAdmins(data) {
  wss.clients.forEach(client => {
    let clientInfo = null;
    for (const [uid, info] of chatClients.entries()) {
      if (info.ws === client) {
        clientInfo = info;
        break;
      }
    }
    
    if (client.readyState === WebSocket.OPEN && clientInfo && clientInfo.isAdmin) {
      client.send(JSON.stringify(data));
    }
  });
}

// --- SCHEDULED TASKS ---

// Auto-delete events 24 hours after they finish
cron.schedule('0 * * * *', () => {
  console.log('Running event cleanup job...');
  const events = readJSON(EVENTS_FILE, []);
  const now = new Date();
  
  const filteredEvents = events.filter(event => {
    if (event.status === 'finished' && event.finishedAt) {
      const finishedTime = new Date(event.finishedAt);
      const hoursDiff = (now - finishedTime) / (1000 * 60 * 60);
      return hoursDiff < 24;
    }
    return true;
  });
  
  if (filteredEvents.length !== events.length) {
    writeJSON(EVENTS_FILE, filteredEvents);
    console.log(`Deleted ${events.length - filteredEvents.length} old events`);
  }
});

// Auto-delete closed tickets after 48 hours
cron.schedule('0 * * * *', () => {
  console.log('Running ticket cleanup job...');
  const tickets = readJSON(TICKETS_FILE, []);
  const now = new Date();
  
  const filteredTickets = tickets.filter(ticket => {
    if (ticket.status === 'closed' && ticket.closedAt) {
      const closedTime = new Date(ticket.closedAt);
      const hoursDiff = (now - closedTime) / (1000 * 60 * 60);
      return hoursDiff < 48;
    }
    return true;
  });
  
  if (filteredTickets.length !== tickets.length) {
    writeJSON(TICKETS_FILE, filteredTickets);
    console.log(`Deleted ${tickets.length - filteredTickets.length} old tickets`);
  }
});

// --- AUTHENTICATION ROUTES ---

// Get current session
app.get('/session', (req, res) => {
  if (req.session.user) {
    return res.json({
      loggedIn: true,
      user: {
        id: req.session.user.id,
        username: req.session.user.username,
        email: req.session.user.email,
        isAdmin: req.session.user.isAdmin || false,
        teamId: req.session.user.teamId || null,
        status: req.session.user.status || 'active'
      }
    });
  }
  res.json({ loggedIn: false });
});

// Signup
app.post('/signup', async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.status(400).json({ ok: false, message: 'All fields are required' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ ok: false, message: 'Passwords do not match' });
  }

  if (password.length < 4) {
    return res.status(400).json({ ok: false, message: 'Password must be at least 4 characters' });
  }

  const users = readJSON(USERS_FILE);
  
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ ok: false, message: 'Username already exists' });
  }

  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ ok: false, message: 'Email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    username,
    email,
    passwordHash,
    isAdmin: false,
    teamId: null,
    status: 'active',
    registeredEvents: [],
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  writeJSON(USERS_FILE, users);

  res.json({ ok: true, message: 'Registration successful' });
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'Username and password required' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => 
    u.username.toLowerCase() === username.toLowerCase() || 
    u.email.toLowerCase() === username.toLowerCase()
  );

  if (!user) {
    return res.status(400).json({ ok: false, message: 'User not found' });
  }

  if (user.status === 'banned') {
    return res.status(403).json({ ok: false, message: 'Your account has been banned', banned: true });
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    return res.status(400).json({ ok: false, message: 'Invalid password' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    isAdmin: user.isAdmin,
    teamId: user.teamId,
    status: user.status
  };

  res.json({ ok: true, message: 'Login successful', isAdmin: user.isAdmin });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    res.json({ ok: true });
  });
});

// --- PASSWORD RESET ROUTES ---

// Request password reset
app.post('/password-reset/request', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, message: 'Email required' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (!user) {
    // Don't reveal if email exists
    return res.json({ ok: true, message: 'If the email exists, a reset link has been sent' });
  }

  const resetTokens = readJSON(RESET_TOKENS_FILE, []);
  const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  resetTokens.push({
    token,
    userId: user.id,
    email: user.email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString() // 1 hour
  });

  writeJSON(RESET_TOKENS_FILE, resetTokens);

  // Simulate email sending (in production, use a real email service)
  console.log('=== PASSWORD RESET EMAIL ===');
  console.log(`To: ${user.email}`);
  console.log(`Reset Link: http://localhost:${PORT}/undersites/password-reset.html?token=${token}`);
  console.log('===========================');

  res.json({ ok: true, message: 'If the email exists, a reset link has been sent' });
});

// Verify reset token
app.post('/password-reset/verify', (req, res) => {
  const { token } = req.body;

  const resetTokens = readJSON(RESET_TOKENS_FILE, []);
  const resetToken = resetTokens.find(t => t.token === token);

  if (!resetToken) {
    return res.status(400).json({ ok: false, message: 'Invalid token' });
  }

  const now = new Date();
  const expiresAt = new Date(resetToken.expiresAt);

  if (now > expiresAt) {
    return res.status(400).json({ ok: false, message: 'Token expired' });
  }

  res.json({ ok: true, email: resetToken.email });
});

// Reset password
app.post('/password-reset/reset', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ ok: false, message: 'Token and new password required' });
  }

  if (newPassword.length < 4) {
    return res.status(400).json({ ok: false, message: 'Password must be at least 4 characters' });
  }

  const resetTokens = readJSON(RESET_TOKENS_FILE, []);
  const resetToken = resetTokens.find(t => t.token === token);

  if (!resetToken) {
    return res.status(400).json({ ok: false, message: 'Invalid token' });
  }

  const now = new Date();
  const expiresAt = new Date(resetToken.expiresAt);

  if (now > expiresAt) {
    return res.status(400).json({ ok: false, message: 'Token expired' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === resetToken.userId);

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  writeJSON(USERS_FILE, users);

  // Remove used token
  const updatedTokens = resetTokens.filter(t => t.token !== token);
  writeJSON(RESET_TOKENS_FILE, updatedTokens);

  res.json({ ok: true, message: 'Password reset successful' });
});

// --- PUSH NOTIFICATION ROUTES ---

// Subscribe to push notifications
app.post('/notifications/subscribe', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { subscription } = req.body;
  const subscriptions = readJSON(PUSH_SUBSCRIPTIONS_FILE, []);

  subscriptions.push({
    userId: req.session.user.id,
    subscription,
    createdAt: new Date().toISOString()
  });

  writeJSON(PUSH_SUBSCRIPTIONS_FILE, subscriptions);
  res.json({ ok: true });
});

// Send notification (admin only)
app.post('/notifications/send', isAdmin, (req, res) => {
  const { title, message, userId } = req.body;

  // In production, use web-push library to send actual notifications
  console.log('=== PUSH NOTIFICATION ===');
  console.log(`Title: ${title}`);
  console.log(`Message: ${message}`);
  console.log(`To User: ${userId || 'All users'}`);
  console.log('========================');

  res.json({ ok: true, message: 'Notification sent (simulated)' });
});

// --- TEAM ROUTES ---

// Create team
app.post('/teams/create', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { name, description, motto } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, message: 'Team name required' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  if (user.teamId) {
    return res.status(400).json({ ok: false, message: 'Already in a team' });
  }

  const teams = readJSON(TEAMS_FILE);
  const teamId = Date.now().toString();
  const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

  const newTeam = {
    id: teamId,
    name,
    description: description || '',
    motto: motto || '',
    captainId: user.id,
    members: [user.id],
    inviteCode,
    createdAt: new Date().toISOString()
  };

  teams.push(newTeam);
  writeJSON(TEAMS_FILE, teams);

  user.teamId = teamId;
  writeJSON(USERS_FILE, users);

  req.session.user.teamId = teamId;

  res.json({ ok: true, team: newTeam });
});

// Get team info
app.get('/teams/:teamId', (req, res) => {
  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === req.params.teamId);

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Team not found' });
  }

  const users = readJSON(USERS_FILE);
  const members = team.members.map(memberId => {
    const user = users.find(u => u.id === memberId);
    return {
      id: user.id,
      username: user.username,
      isCaptain: user.id === team.captainId
    };
  });

  res.json({ ok: true, team: { ...team, memberDetails: members } });
});

// Join team with invite code
app.post('/teams/join', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { inviteCode } = req.body;
  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.inviteCode === inviteCode.toUpperCase());

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Invalid invite code' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  if (user.teamId) {
    return res.status(400).json({ ok: false, message: 'Already in a team' });
  }

  team.members.push(user.id);
  writeJSON(TEAMS_FILE, teams);

  user.teamId = team.id;
  writeJSON(USERS_FILE, users);

  req.session.user.teamId = team.id;

  res.json({ ok: true, team });
});

// Kick member from team (captain only)
app.post('/teams/:teamId/kick', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { memberId } = req.body;
  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === req.params.teamId);

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Team not found' });
  }

  if (team.captainId !== req.session.user.id) {
    return res.status(403).json({ ok: false, message: 'Only captain can kick members' });
  }

  const events = readJSON(EVENTS_FILE);
  const teamInEvent = events.some(e => 
    e.registrations && e.registrations.some(r => r.teamId === team.id)
  );

  if (teamInEvent) {
    return res.status(400).json({ ok: false, message: 'Cannot kick members while registered in an event' });
  }

  team.members = team.members.filter(m => m !== memberId);
  writeJSON(TEAMS_FILE, teams);

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === memberId);
  if (user) {
    user.teamId = null;
    writeJSON(USERS_FILE, users);
  }

  res.json({ ok: true });
});

// Leave team
app.post('/teams/leave', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  if (!user.teamId) {
    return res.status(400).json({ ok: false, message: 'Not in a team' });
  }

  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === user.teamId);

  if (team.captainId === user.id) {
    return res.status(400).json({ ok: false, message: 'Captain cannot leave. Transfer captaincy or disband team' });
  }

  const events = readJSON(EVENTS_FILE);
  const teamInEvent = events.some(e => 
    e.registrations && e.registrations.some(r => r.teamId === team.id)
  );

  if (teamInEvent) {
    return res.status(400).json({ ok: false, message: 'Cannot leave while team is registered in an event' });
  }

  team.members = team.members.filter(m => m !== user.id);
  writeJSON(TEAMS_FILE, teams);

  user.teamId = null;
  writeJSON(USERS_FILE, users);

  req.session.user.teamId = null;

  res.json({ ok: true });
});

// Transfer captaincy (captain only)
app.post('/teams/:teamId/transfer', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { newCaptainId } = req.body;
  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === req.params.teamId);

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Team not found' });
  }

  if (team.captainId !== req.session.user.id) {
    return res.status(403).json({ ok: false, message: 'Only captain can transfer captaincy' });
  }

  if (!team.members.includes(newCaptainId)) {
    return res.status(400).json({ ok: false, message: 'New captain must be a team member' });
  }

  team.captainId = newCaptainId;
  writeJSON(TEAMS_FILE, teams);

  res.json({ ok: true });
});

// Disband team (captain only)
app.post('/teams/:teamId/disband', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === req.params.teamId);

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Team not found' });
  }

  if (team.captainId !== req.session.user.id) {
    return res.status(403).json({ ok: false, message: 'Only captain can disband team' });
  }

  const events = readJSON(EVENTS_FILE);
  const teamInEvent = events.some(e => 
    e.registrations && e.registrations.some(r => r.teamId === team.id)
  );

  if (teamInEvent) {
    return res.status(400).json({ ok: false, message: 'Cannot disband team while registered in an event' });
  }

  // Remove team from all members
  const users = readJSON(USERS_FILE);
  team.members.forEach(memberId => {
    const user = users.find(u => u.id === memberId);
    if (user) {
      user.teamId = null;
    }
  });
  writeJSON(USERS_FILE, users);

  // Delete team
  const updatedTeams = teams.filter(t => t.id !== team.id);
  writeJSON(TEAMS_FILE, updatedTeams);

  req.session.user.teamId = null;

  res.json({ ok: true });
});

// --- EVENT ROUTES ---

// Get all events
app.get('/events', (req, res) => {
  const events = readJSON(EVENTS_FILE);
  res.json({ ok: true, events });
});

// Create event (admin only)
app.post('/events/create', isAdmin, (req, res) => {
  const { name, description, date, time, mode, eliminationType, iconUrl, streamUrl, lobbyUrl, teamSize } = req.body;

  if (!name || !date || !time || !mode) {
    return res.status(400).json({ ok: false, message: 'Missing required fields' });
  }

  // Validate team size
  const validatedTeamSize = teamSize && mode !== 'solo' ? Math.min(Math.max(parseInt(teamSize), 1), 5) : null;

  const events = readJSON(EVENTS_FILE);
  const newEvent = {
    id: Date.now().toString(),
    name,
    description: description || '',
    date,
    time,
    mode,
    eliminationType: eliminationType || 'single',
    iconUrl: iconUrl || '../images/Background.png',
    streamUrl: streamUrl || '',
    lobbyUrl: lobbyUrl || '',
    teamSize: validatedTeamSize,
    status: 'upcoming',
    registrations: [],
    matches: [],
    bracket: null,
    winner: null,
    createdAt: new Date().toISOString()
  };

  events.push(newEvent);
  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, event: newEvent });
});

// Update event image (admin only)
app.post('/events/:eventId/image', isAdmin, (req, res) => {
  const { iconUrl } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  event.iconUrl = iconUrl || '../images/Background.png';
  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, event });
});

// Update event (admin only)
app.put('/events/:eventId', isAdmin, (req, res) => {
  const { name, description, date, time, mode, eliminationType, streamUrl, lobbyUrl, teamSize } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  if (name) event.name = name;
  if (description !== undefined) event.description = description;
  if (date) event.date = date;
  if (time) event.time = time;
  if (mode) event.mode = mode;
  if (eliminationType) event.eliminationType = eliminationType;
  if (streamUrl !== undefined) event.streamUrl = streamUrl;
  if (lobbyUrl !== undefined) event.lobbyUrl = lobbyUrl;
  if (teamSize !== undefined && mode !== 'solo') {
    event.teamSize = Math.min(Math.max(parseInt(teamSize), 1), 5);
  }

  writeJSON(EVENTS_FILE, events);
  res.json({ ok: true, event });
});

// Register for event
app.post('/events/:eventId/register', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const { type } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  if (event.status !== 'upcoming') {
    return res.status(400).json({ ok: false, message: 'Event is not open for registration' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  if (user.status === 'banned' || user.status === 'suspended') {
    return res.status(403).json({ ok: false, message: 'Account restricted' });
  }

  const alreadyRegistered = event.registrations.some(r => 
    r.userId === user.id || (r.teamId && r.teamId === user.teamId)
  );

  if (alreadyRegistered) {
    return res.status(400).json({ ok: false, message: 'Already registered' });
  }

  // Check if registration is closed (now allowed until event starts or even after if status is upcoming)
  const eventDateTime = new Date(`${event.date}T${event.time}`);
  const now = new Date();
  const minutesDiff = (eventDateTime - now) / (1000 * 60);

  // Allow registration until event starts (minutesDiff > 0)
  // If minutesDiff is negative, event has started.
  if (minutesDiff < -5) { // Allow up to 5 mins after start
    return res.status(400).json({ ok: false, message: 'Registration closed' });
  }

  if (type === 'team') {
    if (!user.teamId) {
      return res.status(400).json({ ok: false, message: 'Not in a team' });
    }

    const teams = readJSON(TEAMS_FILE);
    const team = teams.find(t => t.id === user.teamId);

    if (team.captainId !== user.id) {
      return res.status(403).json({ ok: false, message: 'Only captain can register team' });
    }

    // Check team size if specified
    if (event.teamSize && team.members.length > event.teamSize) {
      return res.status(400).json({ 
        ok: false, 
        message: `Team size exceeds limit. This event requires ${event.teamSize} players per team.` 
      });
    }

    event.registrations.push({
      type: 'team',
      teamId: team.id,
      teamName: team.name,
      memberCount: team.members.length,
      registeredAt: new Date().toISOString(),
      checkedIn: false
    });
  } else {
    event.registrations.push({
      type: 'solo',
      userId: user.id,
      username: user.username,
      registeredAt: new Date().toISOString(),
      checkedIn: false
    });
  }

  writeJSON(EVENTS_FILE, events);

  user.registeredEvents = user.registeredEvents || [];
  user.registeredEvents.push(event.id);
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Check-in for event
app.post('/events/:eventId/checkin', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  const eventDateTime = new Date(`${event.date}T${event.time}`);
  const now = new Date();
  const minutesDiff = (eventDateTime - now) / (1000 * 60);

  // Allow check-in between 10 mins before and start time (or slightly after)
  if (minutesDiff > 10) {
    return res.status(400).json({ ok: false, message: 'Check-in opens 10 minutes before the event' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  const registration = event.registrations.find(r => 
    r.userId === user.id || (r.teamId && r.teamId === user.teamId)
  );

  if (!registration) {
    return res.status(400).json({ ok: false, message: 'Not registered' });
  }
  
  // For teams, only captain can check in
  if (registration.type === 'team') {
      const teams = readJSON(TEAMS_FILE);
      const team = teams.find(t => t.id === user.teamId);
      if (team.captainId !== user.id) {
          return res.status(403).json({ ok: false, message: 'Only captain can check in' });
      }
  }

  registration.checkedIn = true;
  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, message: 'Checked in successfully' });
});


// Unregister from event
app.post('/events/:eventId/unregister', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  const eventDateTime = new Date(`${event.date}T${event.time}`);
  const now = new Date();
  const minutesDiff = (eventDateTime - now) / (1000 * 60);

  // Allow unregistering until start
  if (minutesDiff < 0) {
    return res.status(400).json({ ok: false, message: 'Cannot unregister after event start' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  event.registrations = event.registrations.filter(r => 
    r.userId !== user.id && r.teamId !== user.teamId
  );

  writeJSON(EVENTS_FILE, events);

  user.registeredEvents = (user.registeredEvents || []).filter(id => id !== event.id);
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Abandon match
app.post('/events/:eventId/abandon', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  if (event.status !== 'live') {
    return res.status(400).json({ ok: false, message: 'Can only abandon during live events' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.session.user.id);

  event.registrations = event.registrations.filter(r => 
    r.userId !== user.id && r.teamId !== user.teamId
  );

  event.abandoned = event.abandoned || [];
  event.abandoned.push({
    userId: user.id,
    username: user.username,
    abandonedAt: new Date().toISOString()
  });

  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, message: 'Successfully abandoned match' });
});

// Update event status (admin only)
app.post('/events/:eventId/status', isAdmin, (req, res) => {
  const { status, streamUrl, lobbyUrl } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  event.status = status;
  
  if (streamUrl !== undefined) {
    event.streamUrl = streamUrl;
  }

  if (lobbyUrl !== undefined) {
    event.lobbyUrl = lobbyUrl;
  }
  
  if (status === 'finished') {
    event.finishedAt = new Date().toISOString();
  }

  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, event });
});

// Set event winner (admin only)
app.post('/events/:eventId/winner', isAdmin, (req, res) => {
  const { winnerId, winnerName } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  event.winner = {
    id: winnerId,
    name: winnerName,
    announcedAt: new Date().toISOString()
  };

  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, event });
});

// Generate bracket (admin only)
app.post('/events/:eventId/bracket/generate', isAdmin, (req, res) => {
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  // Only include checked-in participants if check-in is required/used
  // For now, we include all registrations but prioritize checked-in ones if we were to implement seeding
  const participants = event.registrations.map((r, index) => ({
    id: r.userId || r.teamId,
    name: r.username || r.teamName,
    seed: index + 1,
    checkedIn: r.checkedIn
  }));

  // Generate single elimination bracket
  // Ensure at least 2 rounds (4 slots)
  const rounds = Math.max(2, Math.ceil(Math.log2(participants.length)));
  const bracket = [];

  for (let round = 0; round < rounds; round++) {
    const matchesInRound = Math.pow(2, rounds - round - 1);
    const roundMatches = [];

    for (let match = 0; match < matchesInRound; match++) {
      if (round === 0) {
        const p1Index = match * 2;
        const p2Index = match * 2 + 1;
        
        roundMatches.push({
          matchId: `R${round}-M${match}`,
          round: round,
          participant1: participants[p1Index] || null,
          participant2: participants[p2Index] || null,
          winner: null,
          scheduledTime: null
        });
      } else {
        roundMatches.push({
          matchId: `R${round}-M${match}`,
          round: round,
          participant1: null,
          participant2: null,
          winner: null,
          scheduledTime: null
        });
      }
    }

    bracket.push(roundMatches);
  }

  event.bracket = bracket;
  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true, bracket });
});

// Update match result (admin only)
app.post('/events/:eventId/matches/:matchId/result', isAdmin, (req, res) => {
  const { winnerId } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event || !event.bracket) {
    return res.status(404).json({ ok: false, message: 'Event or bracket not found' });
  }

  let matchFound = false;
  for (const round of event.bracket) {
    const match = round.find(m => m.matchId === req.params.matchId);
    if (match) {
      const winner = match.participant1?.id === winnerId ? match.participant1 : match.participant2;
      match.winner = winner;
      matchFound = true;

      // Advance winner to next round
      const nextRound = event.bracket[match.round + 1];
      if (nextRound) {
        const nextMatchIndex = Math.floor(round.indexOf(match) / 2);
        const nextMatch = nextRound[nextMatchIndex];
        if (!nextMatch.participant1) {
          nextMatch.participant1 = winner;
        } else {
          nextMatch.participant2 = winner;
        }
      }
      break;
    }
  }

  if (!matchFound) {
    return res.status(404).json({ ok: false, message: 'Match not found' });
  }

  writeJSON(EVENTS_FILE, events);
  res.json({ ok: true, bracket: event.bracket });
});

// Schedule match (admin only)
app.post('/events/:eventId/matches/:matchId/schedule', isAdmin, (req, res) => {
  const { scheduledTime } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === req.params.eventId);

  if (!event || !event.bracket) {
    return res.status(404).json({ ok: false, message: 'Event or bracket not found' });
  }

  let matchFound = false;
  for (const round of event.bracket) {
    const match = round.find(m => m.matchId === req.params.matchId);
    if (match) {
      match.scheduledTime = scheduledTime;
      matchFound = true;
      break;
    }
  }

  if (!matchFound) {
    return res.status(404).json({ ok: false, message: 'Match not found' });
  }

  writeJSON(EVENTS_FILE, events);
  res.json({ ok: true });
});

// Manually update match participants (admin only)
app.post('/events/:eventId/matches/:matchId/update', isAdmin, (req, res) => {
    const { participant1Id, participant2Id } = req.body;
    const events = readJSON(EVENTS_FILE);
    const event = events.find(e => e.id === req.params.eventId);
  
    if (!event || !event.bracket) {
      return res.status(404).json({ ok: false, message: 'Event or bracket not found' });
    }

    // Helper to find participant info from registrations
    const getParticipant = (id) => {
        if (!id) return null;
        const reg = event.registrations.find(r => r.userId === id || r.teamId === id);
        if (!reg) return null;
        return {
            id: reg.userId || reg.teamId,
            name: reg.username || reg.teamName,
            checkedIn: reg.checkedIn
        };
    };
  
    let matchFound = false;
    for (const round of event.bracket) {
      const match = round.find(m => m.matchId === req.params.matchId);
      if (match) {
        if (participant1Id !== undefined) match.participant1 = getParticipant(participant1Id);
        if (participant2Id !== undefined) match.participant2 = getParticipant(participant2Id);
        matchFound = true;
        break;
      }
    }
  
    if (!matchFound) {
      return res.status(404).json({ ok: false, message: 'Match not found' });
    }
  
    writeJSON(EVENTS_FILE, events);
    res.json({ ok: true, bracket: event.bracket });
  });

// Delete event (admin only)
app.delete('/events/:eventId', isAdmin, (req, res) => {
  let events = readJSON(EVENTS_FILE);
  events = events.filter(e => e.id !== req.params.eventId);
  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true });
});

// --- SUPPORT TICKET ROUTES ---

// Create ticket
app.post('/tickets/create', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Please login to submit a support ticket' });
  }

  const { subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ ok: false, message: 'Subject and message required' });
  }

  const tickets = readJSON(TICKETS_FILE);
  const newTicket = {
    id: Date.now().toString(),
    userId: req.session.user.id,
    username: req.session.user.username,
    subject,
    message, // Initial message
    status: 'open',
    responses: [], // Kept for backward compatibility/summary
    messages: [ // Chat history
        {
            id: Date.now().toString(),
            userId: req.session.user.id,
            username: req.session.user.username,
            message: message,
            isAdmin: false,
            timestamp: new Date().toISOString()
        }
    ],
    createdAt: new Date().toISOString(),
    hasUnreadResponse: false
  };

  tickets.push(newTicket);
  writeJSON(TICKETS_FILE, tickets);

  res.json({ ok: true, ticket: newTicket });
});

// Get user's tickets
app.get('/tickets/my', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const tickets = readJSON(TICKETS_FILE);
  const userTickets = tickets.filter(t => t.userId === req.session.user.id);

  res.json({ ok: true, tickets: userTickets });
});

// Mark ticket responses as read
app.post('/tickets/:ticketId/mark-read', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
  }

  const tickets = readJSON(TICKETS_FILE);
  const ticket = tickets.find(t => t.id === req.params.ticketId && t.userId === req.session.user.id);

  if (!ticket) {
    return res.status(404).json({ ok: false, message: 'Ticket not found' });
  }

  ticket.hasUnreadResponse = false;
  writeJSON(TICKETS_FILE, tickets);

  res.json({ ok: true });
});

// Get all tickets (admin only)
app.get('/tickets', isAdmin, (req, res) => {
  const tickets = readJSON(TICKETS_FILE);
  res.json({ ok: true, tickets });
});

// Respond to ticket (admin only) - Legacy/Fallback, Chat is preferred
app.post('/tickets/:ticketId/respond', isAdmin, (req, res) => {
  const { message } = req.body;
  const tickets = readJSON(TICKETS_FILE);
  const ticket = tickets.find(t => t.id === req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ ok: false, message: 'Ticket not found' });
  }

  ticket.responses.push({
    message,
    respondedBy: req.session.user.username,
    respondedAt: new Date().toISOString()
  });
  
  // Also add to messages for chat consistency
  ticket.messages = ticket.messages || [];
  ticket.messages.push({
      id: Date.now().toString(),
      userId: req.session.user.id,
      username: req.session.user.username,
      message: message,
      isAdmin: true,
      timestamp: new Date().toISOString()
  });

  ticket.hasUnreadResponse = true;

  writeJSON(TICKETS_FILE, tickets);

  res.json({ ok: true, ticket });
});

// Close ticket (admin only)
app.post('/tickets/:ticketId/close', isAdmin, (req, res) => {
  const tickets = readJSON(TICKETS_FILE);
  const ticket = tickets.find(t => t.id === req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ ok: false, message: 'Ticket not found' });
  }

  ticket.status = 'closed';
  ticket.closedAt = new Date().toISOString();
  writeJSON(TICKETS_FILE, tickets);

  res.json({ ok: true });
});

// Reopen ticket (admin only)
app.post('/tickets/:ticketId/reopen', isAdmin, (req, res) => {
  const tickets = readJSON(TICKETS_FILE);
  const ticket = tickets.find(t => t.id === req.params.ticketId);

  if (!ticket) {
    return res.status(404).json({ ok: false, message: 'Ticket not found' });
  }

  ticket.status = 'open';
  ticket.closedAt = null;
  writeJSON(TICKETS_FILE, tickets);

  res.json({ ok: true });
});

// --- ADMIN USER MANAGEMENT ROUTES ---

// Get all users (admin only)
app.get('/admin/users', isAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  const safeUsers = users.map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    status: u.status,
    teamId: u.teamId,
    registeredEvents: u.registeredEvents || [],
    createdAt: u.createdAt
  }));

  res.json({ ok: true, users: safeUsers });
});

// Get all teams (admin only)
app.get('/admin/teams', isAdmin, (req, res) => {
  const teams = readJSON(TEAMS_FILE);
  const users = readJSON(USERS_FILE);

  const teamsWithDetails = teams.map(team => {
    const captain = users.find(u => u.id === team.captainId);
    const members = team.members.map(memberId => {
      const member = users.find(u => u.id === memberId);
      return {
        id: member.id,
        username: member.username
      };
    });

    return {
      ...team,
      captainName: captain ? captain.username : 'Unknown',
      memberDetails: members
    };
  });

  res.json({ ok: true, teams: teamsWithDetails });
});

// Delete team (admin only)
app.delete('/admin/teams/:teamId', isAdmin, (req, res) => {
  const teams = readJSON(TEAMS_FILE);
  const team = teams.find(t => t.id === req.params.teamId);

  if (!team) {
    return res.status(404).json({ ok: false, message: 'Team not found' });
  }

  // Remove team from all members
  const users = readJSON(USERS_FILE);
  team.members.forEach(memberId => {
    const user = users.find(u => u.id === memberId);
    if (user) {
      user.teamId = null;
    }
  });
  writeJSON(USERS_FILE, users);

  // Delete team
  const updatedTeams = teams.filter(t => t.id !== team.id);
  writeJSON(TEAMS_FILE, updatedTeams);

  res.json({ ok: true });
});

// Ban user (admin only)
app.post('/admin/users/:userId/ban', isAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  user.status = 'banned';
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Suspend user (admin only)
app.post('/admin/users/:userId/suspend', isAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  user.status = 'suspended';
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Activate user (admin only)
app.post('/admin/users/:userId/activate', isAdmin, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  user.status = 'active';
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Delete user account (admin only)
app.delete('/admin/users/:userId', isAdmin, (req, res) => {
  let users = readJSON(USERS_FILE);
  users = users.filter(u => u.id !== req.params.userId);
  writeJSON(USERS_FILE, users);

  res.json({ ok: true });
});

// Disqualify user from event (admin only)
app.post('/admin/users/:userId/disqualify', isAdmin, (req, res) => {
  const { eventId } = req.body;
  const events = readJSON(EVENTS_FILE);
  const event = events.find(e => e.id === eventId);

  if (!event) {
    return res.status(404).json({ ok: false, message: 'Event not found' });
  }

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.userId);

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found' });
  }

  event.registrations = event.registrations.filter(r => 
    r.userId !== user.id && r.teamId !== user.teamId
  );

  event.disqualified = event.disqualified || [];
  event.disqualified.push({
    userId: user.id,
    username: user.username,
    disqualifiedAt: new Date().toISOString()
  });

  writeJSON(EVENTS_FILE, events);

  res.json({ ok: true });
});

// Start server
server.listen(PORT, () => {
  console.log(`Slovak Patriot server running at http://localhost:${PORT}`);
  console.log('WebSocket server is ready for chat connections');
});