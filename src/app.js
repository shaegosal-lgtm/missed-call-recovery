require('dotenv').config();
console.log('ENV CHECK - SID starts with:', process.env.TWILIO_ACCOUNT_SID?.substring(0, 4));
const express = require('express');

const twilioRoutes = require('./routes/twilio');
const leadRoutes = require('./routes/leads');
const appointmentRoutes = require('./routes/appointments');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/webhooks/twilio', twilioRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/appointments', appointmentRoutes);

app.get('/', (req, res) => res.send('Missed call recovery server is running.'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});