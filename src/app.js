require('dotenv').config();
const express = require('express');

const twilioRoutes = require('./routes/twilio');
const leadRoutes = require('./routes/leads');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/webhooks/twilio', twilioRoutes);
app.use('/api/leads', leadRoutes);

app.get('/', (req, res) => res.send('Missed call recovery server is running.'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});