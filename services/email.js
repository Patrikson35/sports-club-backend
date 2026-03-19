const nodemailer = require('nodemailer');

/**
 * Email Service
 * 
 * Development: Používa console.log (mock)
 * Production: Používa SMTP (Gmail, SendGrid, atď.)
 */

// Create transporter
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  // Production: Use SMTP
  if (process.env.NODE_ENV === 'production' && process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    console.log('✅ Email service: SMTP configured');
  } 
  // Development: Mock (console.log)
  else {
    console.log('⚠️ Email service: MOCK mode (emails logged to console)');
    transporter = {
      sendMail: async (mailOptions) => {
        console.log('\n📧 ========== MOCK EMAIL ==========');
        console.log('From:', mailOptions.from);
        console.log('To:', mailOptions.to);
        console.log('Subject:', mailOptions.subject);
        console.log('HTML:', mailOptions.html?.substring(0, 200) + '...');
        console.log('===================================\n');
        return { messageId: 'mock-' + Date.now() };
      }
    };
  }

  return transporter;
};

/**
 * Send email
 * 
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} options.text - Plain text body (optional)
 */
async function sendEmail({ to, subject, html, text }) {
  try {
    const transport = getTransporter();
    
    const mailOptions = {
      from: process.env.SMTP_FROM || '"Sports Club" <noreply@sportsclub.com>',
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
    };

    const info = await transport.sendMail(mailOptions);
    console.log(`✅ Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error('❌ Email send error:', error.message);
    // Don't throw - just log error so registration doesn't fail
    return { error: error.message };
  }
}

/**
 * Send email verification
 */
async function sendVerificationEmail(to, token, firstName) {
  const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}`;
  
  return sendEmail({
    to,
    subject: 'Overte svoj email - Sports Club',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1976d2;">Vitajte v Sports Club!</h1>
        <p>Ahoj ${firstName},</p>
        <p>Ďakujeme za registráciu. Pre dokončenie aktivácie účtu kliknite na tlačidlo:</p>
        <a href="${verificationUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Overiť email
        </a>
        <p>Alebo skopírujte tento odkaz do prehliadača:</p>
        <p style="color: #666; font-size: 14px; word-break: break-all;">${verificationUrl}</p>
        <p style="color: #999; font-size: 12px; margin-top: 40px;">
          Tento odkaz vyprší za 24 hodín.<br>
          Ak ste sa neregistrovali, ignorujte tento email.
        </p>
      </div>
    `
  });
}

/**
 * Send invite email
 */
async function sendInviteEmail(to, inviteCode, inviteType, clubName, inviterName) {
  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/register?invite=${inviteCode}`;
  
  const roleNames = {
    coach: 'tréner',
    assistant: 'asistent',
    player: 'hráč',
    parent: 'rodič'
  };

  return sendEmail({
    to,
    subject: `Pozvánka do klubu ${clubName} - Sports Club`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1976d2;">Pozvánka do ${clubName}</h1>
        <p>${inviterName} vás pozýva ako <strong>${roleNames[inviteType]}</strong> do klubu ${clubName}.</p>
        <p>Pre dokončenie registrácie kliknite na tlačidlo:</p>
        <a href="${inviteUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Prijať pozvánku
        </a>
        <p>Alebo skopírujte tento odkaz:</p>
        <p style="color: #666; font-size: 14px; word-break: break-all;">${inviteUrl}</p>
        <p style="color: #999; font-size: 12px; margin-top: 40px;">
          Táto pozvánka vyprší za 7 dní.
        </p>
      </div>
    `
  });
}

/**
 * Send parent consent email (COPPA)
 */
async function sendParentConsentEmail(to, token, parentName, childName, childAge) {
  const consentUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/parent-consent?token=${token}`;
  
  return sendEmail({
    to,
    subject: `Rodičovský súhlas pre ${childName} - Sports Club`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1976d2;">Rodičovský súhlas</h1>
        <p>Ahoj ${parentName},</p>
        <p>Vaše dieťa <strong>${childName}</strong> (${childAge} rokov) sa registrovalo do Sports Club.</p>
        <p>Keďže má menej ako 16 rokov, potrebujeme váš súhlas na spracovanie osobných údajov.</p>
        <p>Prosím prečítajte si informácie a udeľte súhlas:</p>
        <a href="${consentUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Udeliť súhlas
        </a>
        <p>Alebo skopírujte odkaz:</p>
        <p style="color: #666; font-size: 14px; word-break: break-all;">${consentUrl}</p>
        <p style="color: #999; font-size: 12px; margin-top: 40px;">
          Tento odkaz vyprší za 7 dní.<br>
          Bez vášho súhlasu nemôže dieťa používať službu.
        </p>
      </div>
    `
  });
}

/**
 * Send password reset email
 */
async function sendPasswordResetEmail(to, token, firstName) {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
  
  return sendEmail({
    to,
    subject: 'Obnovenie hesla - Sports Club',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #1976d2;">Obnovenie hesla</h1>
        <p>Ahoj ${firstName},</p>
        <p>Požiadali ste o obnovenie hesla. Kliknite na tlačidlo:</p>
        <a href="${resetUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #1976d2; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Obnoviť heslo
        </a>
        <p>Odkaz:</p>
        <p style="color: #666; font-size: 14px; word-break: break-all;">${resetUrl}</p>
        <p style="color: #999; font-size: 12px; margin-top: 40px;">
          Tento odkaz vyprší za 1 hodinu.<br>
          Ak ste o obnovu nežiadali, ignorujte tento email.
        </p>
      </div>
    `
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendInviteEmail,
  sendParentConsentEmail,
  sendPasswordResetEmail
};
