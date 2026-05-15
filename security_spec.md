# Security Specification: Dental Clinic Platform

## 1. Data Invariants
- An `Appointment` must have a valid `patientId` matching the authenticated user.
- Patients cannot modify their `role` or `medicalHistory` after creation (Admin only).
- `Service` prices and details can only be modified by Admins.
- Chat messages are private to the participants.
- Testimonials require a verified patient account.

## 2. The "Dirty Dozen" Payloads (Attacker Strategy)
1. **Identity Spoofing**: Attempt to create an appointment with another user's `patientId`.
2. **Privilege Escalation**: Attempt to update own user profile `role` to 'admin'.
3. **Data Poisoning**: Inject a 2MB string into Appointment `notes`.
4. **Relational Bypass**: Create a testimonial for a service that doesn't exist.
5. **Unauthorized Inspection**: Attempt to list all `appointments` as a non-admin user.
6. **Chat Snooping**: Read messages in a `chatId` where the user is not a participant.
7. **Service Tampering**: Attempt to lower the price of a 'Teeth Whitening' service.
8. **Testimonial Injection**: Submit a testimonial without being signed in.
9. **Record Tampering**: Attempt to edit another patient's medical history.
10. **ID Poisoning**: Use a document ID matching reserved system names.
11. **Shadow Field**: Add a `isVerified: true` field to a patient profile during update.
12. **Status Skipping**: Update Appointment status directly to 'completed' as a patient.

## 3. Test Runner (Mock Tests)
- `PERMISSION_DENIED` expected for all "Dirty Dozen" payloads.
- `ALLOW` expected for:
    - Patient reading their own appointments.
    - Public reading services and gallery.
    - Admin managing all bookings.
