const bcrypt = require('bcryptjs');
const fs = require('fs');

async function createAdmin() {
  const users = [];
  const passwordHash = await bcrypt.hash('admin123', 10);
  
  const adminUser = {
    id: Date.now().toString(),
    username: 'admin',
    email: 'admin@slovakpatriot.sk',
    passwordHash,
    isAdmin: true,
    teamId: null,
    status: 'active',
    registeredEvents: [],
    createdAt: new Date().toISOString()
  };
  
  users.push(adminUser);
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  console.log('Admin user created successfully!');
  console.log('Username: admin');
  console.log('Password: admin123');
}

createAdmin();