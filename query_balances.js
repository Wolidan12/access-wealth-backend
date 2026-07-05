const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
  db.get('select count(*) as c from users', (err, row) => {
    if (err) { console.error(err); return; }
    console.log('users', row.c);
  });
  db.all('select username,balance,taskEarnings,daily_earnings,affiliate_balance,status from users order by id desc limit 10', (err, rows) => {
    if (err) { console.error(err); return; }
    console.log(JSON.stringify(rows, null, 2));
  });
});
db.on('error', (err) => console.error('db error', err));
db.close();
