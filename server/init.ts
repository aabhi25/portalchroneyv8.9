import { storage } from "./storage";
import { hashPassword } from "./auth";
import { jewelryImageGeneratorService } from "./services/jewelryImageGeneratorService";
import { visionWarehouseSyncService } from "./services/visionWarehouseSyncService";
import { db } from "./db";
import { whatsappLeadFields } from "../shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * Initialize the database with a default superadmin if none exists
 * This runs on server startup to ensure there's always a way to log in
 */
export async function initializeDatabase() {
  try {
    // Recover any stuck Vista Studio jobs from previous server session
    try {
      const recoveredCount = await jewelryImageGeneratorService.recoverStuckJobs();
      if (recoveredCount > 0) {
        console.log(`[INIT] ✓ Recovered ${recoveredCount} stuck Vista Studio job(s)`);
      }
    } catch (err) {
      console.error('[INIT] Error recovering stuck jobs:', err);
    }

    // Check if any superadmin users exist
    const superadmins = await storage.getSuperadmins();
    
    if (superadmins.length === 0) {
      console.log('[INIT] No superadmin found. Creating default superadmin account...');
      
      // Get credentials from environment variables or use defaults
      const username = process.env.SUPERADMIN_USERNAME || 'admin';
      const password = process.env.SUPERADMIN_PASSWORD || 'admin123';
      
      // Hash the password
      const passwordHash = await hashPassword(password);
      
      // Create the superadmin user
      await storage.createUser({
        username,
        passwordHash,
        role: 'super_admin',
        businessAccountId: null,
      });
      
      console.log(`[INIT] ✓ Default superadmin created with username: ${username}`);
      console.log(`[INIT] ⚠️  Please log in and change the password immediately!`);
      
      if (!process.env.SUPERADMIN_USERNAME || !process.env.SUPERADMIN_PASSWORD) {
        console.log('[INIT] ⚠️  Using default credentials. Set SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD environment variables for better security.');
      }
    } else {
      console.log(`[INIT] ✓ Found ${superadmins.length} superadmin account(s)`);
    }
    
    // Backfill defaultCrmFieldKey for existing default WhatsApp lead fields (idempotent migration)
    try {
      const DEFAULT_CRM_KEYS: Record<string, string> = {
        customer_name: 'Name',
        customer_phone: 'Mobile',
        customer_email: 'Email',
      };
      for (const [fieldKey, crmKey] of Object.entries(DEFAULT_CRM_KEYS)) {
        await db.update(whatsappLeadFields)
          .set({ defaultCrmFieldKey: crmKey })
          .where(and(
            eq(whatsappLeadFields.fieldKey, fieldKey),
            eq(whatsappLeadFields.isDefault, true),
            isNull(whatsappLeadFields.defaultCrmFieldKey)
          ));
      }
    } catch (err) {
      console.error('[INIT] Error backfilling default CRM field keys:', err);
    }

    try {
      await db.execute(sql`ALTER TABLE crm_store_credentials ADD COLUMN IF NOT EXISTS city TEXT`);
    } catch (err) {
      console.error('[INIT] Error adding city column to crm_store_credentials:', err);
    }

    try {
      await db.execute(sql`ALTER TABLE custom_crm_settings ADD COLUMN IF NOT EXISTS callback_url TEXT`);
    } catch (err) {
      console.error('[INIT] Error adding callback_url column to custom_crm_settings:', err);
    }

    // Resume any interrupted Vision Warehouse syncs
    try {
      await visionWarehouseSyncService.resumeInterruptedSyncs();
    } catch (err) {
      console.error('[INIT] Error resuming Vision Warehouse syncs:', err);
    }
  } catch (error) {
    console.error('[INIT] Error initializing database:', error);
    throw error;
  }
}
