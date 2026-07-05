fetch('http://localhost:3000/api/state', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ clients: [], loans: [], smsHistory: [], settings: {} })
})
.then(res => res.json())
.then(data => {
  console.log("DB RESET VIA API:", data);
  process.exit(0);
})
.catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
