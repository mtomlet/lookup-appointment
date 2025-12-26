const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const CONFIG = {
  AUTH_URL: 'https://d18devmarketplace.meevodev.com/oauth2/token',
  API_URL: 'https://d18devpub.meevodev.com/publicapi/v1',
  CLIENT_ID: 'a7139b22-775f-4938-8ecb-54aa23a1948d',
  CLIENT_SECRET: 'b566556f-e65d-47dd-a27d-dd1060d9fe2d',
  TENANT_ID: '4',
  LOCATION_ID: '5'
};

let token = null;
let tokenExpiry = null;

// Normalize phone to 10-digit format (strips +1 country code and non-digits)
function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  // If 11 digits starting with 1, strip the country code
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

async function getToken() {
  if (token && tokenExpiry && Date.now() < tokenExpiry - 300000) return token;

  const res = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return token;
}

app.post('/lookup', async (req, res) => {
  try {
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.json({
        success: false,
        error: 'Please provide phone or email'
      });
    }

    const authToken = await getToken();

    // Step 1: Find client by phone or email
    const clientsRes = await axios.get(
      `${CONFIG.API_URL}/clients?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
      { headers: { Authorization: `Bearer ${authToken}` }}
    );

    const clients = clientsRes.data.data || clientsRes.data;
    const client = clients.find(c => {
      if (phone) {
        const cleanPhone = normalizePhone(phone);
        const clientPhone = normalizePhone(c.primaryPhoneNumber);
        return clientPhone === cleanPhone;
      }
      if (email) {
        return c.emailAddress?.toLowerCase() === email.toLowerCase();
      }
      return false;
    });

    if (!client) {
      return res.json({
        success: true,
        found: false,
        appointments: [],
        message: 'No client found with that phone number or email'
      });
    }

    console.log('Client found:', client.firstName, client.lastName, client.clientId);

    // Step 2: Get client's appointments
    const appointmentsRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${client.clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
      { headers: { Authorization: `Bearer ${authToken}` }}
    );

    const allAppointments = appointmentsRes.data.data || appointmentsRes.data;

    // Step 3: Filter for upcoming appointments (including same-day past appointments)
    // This ensures we can find/cancel same-day appointments that Meevo still has
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const upcomingAppointments = allAppointments.filter(apt => {
      const aptTime = new Date(apt.startTime);
      // Include if: future appointment OR same-day appointment (even if past start time)
      return (aptTime > now || aptTime >= startOfToday) && !apt.isCancelled;
    });

    // Step 4: Format response
    const formattedAppointments = upcomingAppointments.map(apt => ({
      appointment_id: apt.appointmentId,
      appointment_service_id: apt.appointmentServiceId,
      datetime: apt.startTime,
      end_time: apt.servicingEndTime,
      service_id: apt.serviceId,
      stylist_id: apt.employeeId,
      concurrency_check: apt.concurrencyCheckDigits,
      status: apt.isCancelled ? 'cancelled' : 'confirmed'
    }));

    res.json({
      success: true,
      found: true,
      client_name: `${client.firstName} ${client.lastName}`,
      client_id: client.clientId,
      appointments: formattedAppointments,
      total: formattedAppointments.length,
      message: `Found ${formattedAppointments.length} upcoming appointment(s)`
    });

  } catch (error) {
    console.error('Lookup error:', error.message);
    res.json({
      success: false,
      error: error.response?.data?.error?.message || error.message
    });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Lookup server running on port ${PORT}`));
