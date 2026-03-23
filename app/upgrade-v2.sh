#!/bin/sh

echo "Upgrading Mini HR to Version 2..."

cat <<'EOF' > server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));
app.use(express.static('public'));

app.use(session({
  secret: 'minihrsecret',
  resave: false,
  saveUninitialized: true
}));

const db = new sqlite3.Database('leave.db');

db.serialize(()=>{
 db.run("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password TEXT, role TEXT, annual INTEGER)");
 db.run("CREATE TABLE IF NOT EXISTS leaves(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, days INTEGER, status TEXT)");

 db.get("SELECT COUNT(*) as c FROM users",(err,row)=>{
   if(row.c===0){
     db.run("INSERT INTO users(username,password,role,annual) VALUES('admin','admin','admin',25)");
     db.run("INSERT INTO users(username,password,role,annual) VALUES('user','user','employee',25)");
   }
 });
});

function auth(req,res,next){
 if(!req.session.user) return res.redirect('/login.html');
 next();
}

app.post('/login',(req,res)=>{
 const {username,password}=req.body;
 db.get("SELECT * FROM users WHERE username=? AND password=?",[username,password],(e,u)=>{
   if(u){
     req.session.user=u;
     res.redirect('/');
   }else{
     res.send("Login failed");
   }
 });
});

app.get('/logout',(req,res)=>{
 req.session.destroy(()=>res.redirect('/login.html'));
});

app.get('/balance',auth,(req,res)=>{
 db.get("SELECT SUM(days) as used FROM leaves WHERE username=? AND status='approved'",[req.session.user.username],(e,row)=>{
   let used=row.used||0;
   let remaining=req.session.user.annual-used;
   res.json({annual:req.session.user.annual,used,remaining});
 });
});

app.get('/leaves',auth,(req,res)=>{
 if(req.session.user.role==='admin'){
   db.all("SELECT * FROM leaves",[],(e,rows)=>res.json(rows));
 }else{
   db.all("SELECT * FROM leaves WHERE username=?",[req.session.user.username],(e,rows)=>res.json(rows));
 }
});

app.post('/leave',auth,(req,res)=>{
 const {days}=req.body;
 db.run("INSERT INTO leaves(username,days,status) VALUES(?,?,?)",[req.session.user.username,days,'pending']);
 res.json({status:'requested'});
});

app.post('/approve',auth,(req,res)=>{
 if(req.session.user.role!=='admin') return res.send("denied");
 const {id}=req.body;
 db.run("UPDATE leaves SET status='approved' WHERE id=?",[id]);
 res.json({status:'approved'});
});

app.listen(5050,()=>console.log("Mini HR v2 running"));
EOF

mkdir -p public

cat <<'EOF' > public/login.html
<h2>Login</h2>
<form method="post" action="/login">
User: <input name="username"><br>
Pass: <input name="password" type="password"><br>
<button>Login</button>
</form>
EOF

cat <<'EOF' > public/index.html
<h2>Mini HR Dashboard</h2>

<button onclick="logout()">Logout</button>

<h3>Leave Balance</h3>
<pre id="bal"></pre>

<h3>Request Leave</h3>
<input id="days" placeholder="Days">
<button onclick="req()">Request</button>

<h3>Leaves</h3>
<pre id="list"></pre>

<script>
async function load(){
 let b=await fetch('/balance'); bal.innerText=JSON.stringify(await b.json(),null,2);
 let l=await fetch('/leaves'); list.innerText=JSON.stringify(await l.json(),null,2);
}
async function req(){
 await fetch('/leave',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:days.value})});
 load();
}
function logout(){ location='/logout'; }
load();
</script>
EOF

echo "Upgrade done"
echo "Restart container: docker restart minihr"
