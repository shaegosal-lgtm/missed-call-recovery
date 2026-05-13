const twilio = require('twilio');

module.exports = function twilioAuth(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  
  // Build URL using the forwarded host from ngrok
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${host}${req.originalUrl}`;
  
  const isValid = twilio.validateRequest(authToken, signature, url, req.body);
  
  if (!isValid) {
    console.warn('Invalid Twilio signature — request rejected');
    console.warn('URL used for validation:', url);
    return res.status(403).send('Forbidden');
  }
  
  next();
};