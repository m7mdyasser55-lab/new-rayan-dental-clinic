import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

// Load Firebase Config
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
console.log("Loading Firebase config from:", configPath);
if (!fs.existsSync(configPath)) {
  console.error("Firebase config file not found at:", configPath);
  throw new Error("firebase-applet-config.json missing");
}
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

admin.initializeApp({
  projectId: firebaseConfig.projectId,
});

const db = getFirestore(firebaseConfig.firestoreDatabaseId || "(default)");

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Email Transporter (Lazy loaded or configured via env)
  const getTransporter = () => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn("Email credentials missing. Reminders will be logged to console instead of sent.");
      return null;
    }
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  };

  // API Route to manually trigger reminders (for testing)
  app.post("/api/admin/trigger-reminders", async (req, res) => {
    try {
      await checkAndSendReminders();
      res.json({ status: "ok", message: "Reminder check triggered" });
    } catch (error) {
      console.error("Manual reminder trigger failed:", error);
      res.status(500).json({ status: "error", message: String(error) });
    }
  });

  // API Route to handle new bookings and send immediate notifications
  app.post("/api/appointments", async (req, res) => {
    try {
      const appointment = {
        ...req.body,
        createdAt: FieldValue.serverTimestamp(),
        status: "pending",
      };

      const docRef = await db.collection("appointments").add(appointment);
      
      // Send notification email to the clinic
      const transporter = getTransporter();
      if (transporter) {
        const { patientName, patientPhone, serviceName, date, time, notes } = req.body;
        const mailOptions = {
          from: `"عيادة ريان" <${process.env.EMAIL_USER}>`,
          to: "rayandentalcare170@gmail.com",
          subject: "حجز جديد - عيادة ريان",
          html: `
            <div dir="rtl" style="font-family: sans-serif; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
              <h2 style="color: #0d9488;">تم استلام طلب حجز جديد!</h2>
              <p><strong>اسم المريض:</strong> ${patientName}</p>
              <p><strong>رقم الهاتف:</strong> ${patientPhone}</p>
              <p><strong>الخدمة:</strong> ${serviceName}</p>
              <p><strong>التاريخ:</strong> ${date}</p>
              <p><strong>الوقت:</strong> ${time}</p>
              <p><strong>ملاحظات:</strong> ${notes || "لا توجد"}</p>
              <hr style="border: 0; border-top: 1px solid #eee;" />
              <p style="font-size: 0.8em; color: #666;">تم إرسال هذا البريد تلقائياً من نظام عيادة ريان.</p>
            </div>
          `,
        };
        
        transporter.sendMail(mailOptions).catch(err => console.error("Notification email failed:", err));
      }

      res.json({ status: "ok", id: docRef.id });
    } catch (error) {
      console.error("Booking failed:", error);
      res.status(500).json({ status: "error", message: String(error) });
    }
  });

  // API Route to handle contact form messages
  app.post("/api/messages", async (req, res) => {
    try {
      const messageData = {
        ...req.body,
        createdAt: FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection("messages").add(messageData);

      // Send notification email
      const transporter = getTransporter();
      if (transporter) {
        const { name, email, message } = req.body;
        const mailOptions = {
          from: `"عيادة ريان" <${process.env.EMAIL_USER}>`,
          to: "rayandentalcare170@gmail.com",
          subject: "رسالة جديدة من الموقع - عيادة ريان",
          html: `
            <div dir="rtl" style="font-family: sans-serif; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
              <h2 style="color: #0d9488;">رسالة جديدة!</h2>
              <p><strong>الاسم:</strong> ${name}</p>
              <p><strong>البريد الإلكتروني:</strong> ${email}</p>
              <p><strong>الرسالة:</strong></p>
              <div style="background: #f9f9f9; padding: 15px; border-radius: 5px;">${message}</div>
              <hr style="border: 0; border-top: 1px solid #eee;" />
              <p style="font-size: 0.8em; color: #666;">تم إرسال هذا البريد تلقائياً من نظام عيادة ريان.</p>
            </div>
          `,
        };
        transporter.sendMail(mailOptions).catch(err => console.error("Message email failed:", err));
      }

      res.json({ status: "ok", id: docRef.id });
    } catch (error) {
      console.error("Message submission failed:", error);
      res.status(500).json({ status: "error", message: String(error) });
    }
  });

  // API Route to update reminder settings
  app.post("/api/admin/settings", async (req, res) => {
    console.log("Received settings update request:", req.body);
    try {
      const { reminderHours } = req.body;
      if (typeof reminderHours !== 'number') {
        throw new Error("Invalid reminderHours type: " + typeof reminderHours);
      }
      const settingsRef = db.collection("settings").doc("reminders");
      await settingsRef.set({ reminderHours }, { merge: true });
      console.log("Settings updated successfully");
      res.json({ status: "ok" });
    } catch (error) {
      console.error("Failed to update settings:", error);
      res.status(500).json({ status: "error", message: error instanceof Error ? error.message : "Failed to update settings" });
    }
  });

  // Cron Job: Run every hour
  cron.schedule("0 * * * *", async () => {
    console.log("Running scheduled reminder check...");
    await checkAndSendReminders();
  });

  async function checkAndSendReminders() {
    // 1. Get Settings
    let reminderHours = 24;
    try {
      const settingsSnap = await db.collection("settings").doc("reminders").get();
      if (settingsSnap.exists) {
        reminderHours = settingsSnap.data()?.reminderHours || 24;
      }
    } catch (e) {
      console.log("Using default reminder settings (24h)");
    }

    // 2. Query upcoming confirmed appointments that haven't received a reminder
    const now = new Date();
    
    // We fetch all confirmed appointments and filter manually to avoid complex indexing requirements initially
    const snapshot = await db.collection("appointments")
      .where("status", "==", "confirmed")
      .get();

    const transporter = getTransporter();

    for (const d of snapshot.docs) {
      const apt = d.data();
      if (apt.reminderSent) continue;

      // Appointment date and time parsing
      // Assuming apt.date is YYYY-MM-DD and apt.time is HH:mm
      const aptDate = new Date(`${apt.date}T${apt.time}`);
      
      const hoursUntilApt = (aptDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      // If appointment is within the reminder window (e.g. 23-24 hours away)
      if (hoursUntilApt > 0 && hoursUntilApt <= reminderHours) {
        console.log(`Sending reminder to ${apt.patientName} for appointment at ${apt.date} ${apt.time}`);
        
        const message = `مرحباً ${apt.patientName}، نذكرك بموعدك لدى عيادة ريان لطب الأسنان يوم ${apt.date} الساعة ${apt.time}. نتطلع لرؤيتك!`;

        if (transporter) {
          try {
            await transporter.sendMail({
              from: `"عيادة ريان" <${process.env.EMAIL_USER}>`,
              to: apt.patientEmail || "rayandentalcare170@gmail.com", // Fallback to business email if missing
              subject: "تذكير بموعدك - عيادة ريان",
              text: message,
              html: `<div dir="rtl" style="font-family: sans-serif; padding: 20px;">
                <h2>تذكير بموعدك</h2>
                <p>${message}</p>
                <hr />
                <p>عنواننا: الإسكندرية، محرم بك</p>
              </div>`
            });
          } catch (mailError) {
            console.error("Failed to send email:", mailError);
            continue; // Don't mark as sent if it failed
          }
        } else {
          console.log("REMAINDER LOG (No Mailer):", message);
        }

        // Mark as sent
        await db.collection("appointments").doc(d.id).update({
          reminderSent: true
        });
      }
    }
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
