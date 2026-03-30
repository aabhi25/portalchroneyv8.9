import { db } from "../db";
import { whatsappSessions, whatsappLeads, type WhatsappSettings } from "@shared/schema";
import { eq, and } from "drizzle-orm";

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function updateSession(businessAccountId: string, phoneNumber: string): Promise<void> {
  const cleanPhone = phoneNumber.replace(/\D/g, "");
  try {
    const existing = await db
      .select()
      .from(whatsappSessions)
      .where(and(
        eq(whatsappSessions.businessAccountId, businessAccountId),
        eq(whatsappSessions.phoneNumber, cleanPhone)
      ))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(whatsappSessions)
        .set({
          lastUserMessageAt: new Date(),
          sessionActive: true,
          updatedAt: new Date(),
        })
        .where(eq(whatsappSessions.id, existing[0].id));
    } else {
      await db.insert(whatsappSessions).values({
        businessAccountId,
        phoneNumber: cleanPhone,
        lastUserMessageAt: new Date(),
        sessionActive: true,
      });
    }
    console.log(`[WA Session] Updated session for ${cleanPhone} (business: ${businessAccountId})`);
  } catch (err) {
    console.error(`[WA Session] Failed to update session for ${cleanPhone}:`, err);
  }
}

export async function isSessionActive(businessAccountId: string, phoneNumber: string): Promise<boolean> {
  const cleanPhone = phoneNumber.replace(/\D/g, "");
  try {
    const [session] = await db
      .select()
      .from(whatsappSessions)
      .where(and(
        eq(whatsappSessions.businessAccountId, businessAccountId),
        eq(whatsappSessions.phoneNumber, cleanPhone)
      ))
      .limit(1);

    if (!session) return false;
    if (!session.sessionActive) return false;

    const elapsed = Date.now() - new Date(session.lastUserMessageAt).getTime();
    return elapsed < SESSION_WINDOW_MS;
  } catch (err) {
    console.error(`[WA Session] Failed to check session for ${cleanPhone}:`, err);
    return false;
  }
}

export async function markSessionExpired(businessAccountId: string, phoneNumber: string): Promise<void> {
  const cleanPhone = phoneNumber.replace(/\D/g, "");
  try {
    await db
      .update(whatsappSessions)
      .set({ sessionActive: false, updatedAt: new Date() })
      .where(and(
        eq(whatsappSessions.businessAccountId, businessAccountId),
        eq(whatsappSessions.phoneNumber, cleanPhone)
      ));
    console.log(`[WA Session] Marked session expired for ${cleanPhone}`);
  } catch (err) {
    console.error(`[WA Session] Failed to mark session expired for ${cleanPhone}:`, err);
  }
}

export async function sendTemplateMessage(
  settings: WhatsappSettings,
  recipientPhone: string,
  templateName: string,
  params: Record<string, string> = {}
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!settings.msg91AuthKey) {
      return { success: false, error: "MSG91 auth key not configured" };
    }
    if (!settings.msg91IntegratedNumberId) {
      return { success: false, error: "MSG91 integrated number ID not configured" };
    }

    const cleanPhone = recipientPhone.replace(/\D/g, "");

    const body: Record<string, any> = {
      integrated_number: settings.msg91IntegratedNumberId,
      content_type: "template",
      payload: {
        to: cleanPhone,
        type: "template",
        template: {
          name: templateName,
          language: {
            code: "en",
            policy: "deterministic",
          },
          components: [] as any[],
        },
      },
    };

    if (Object.keys(params).length > 0) {
      const parameters = Object.values(params).map((value) => ({
        type: "text",
        text: value,
      }));
      body.payload.template.components.push({
        type: "body",
        parameters,
      });
    }

    if (settings.sessionTemplateNamespace) {
      body.payload.template.namespace = settings.sessionTemplateNamespace;
    }

    const url = `https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/`;

    console.log(`[WA Session] Sending template "${templateName}" to ${cleanPhone}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authkey: settings.msg91AuthKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseData = await response.json();
    console.log(`[WA Session] Template response:`, responseData);

    if (responseData.status === "fail" || responseData.hasError) {
      return {
        success: false,
        error: responseData.errors || responseData.message || `MSG91 error: ${response.status}`,
      };
    }

    await storeOutgoingTemplateMessage(
      settings.businessAccountId,
      recipientPhone,
      `[Template: ${templateName}]`
    );

    return {
      success: true,
      messageId: responseData.data?.id || responseData.message_id,
    };
  } catch (error) {
    console.error(`[WA Session] Template send error:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send template",
    };
  }
}

async function storeOutgoingTemplateMessage(
  businessAccountId: string,
  recipientPhone: string,
  text: string
): Promise<void> {
  try {
    const cleanPhone = recipientPhone.replace(/\D/g, "");
    await db.insert(whatsappLeads).values({
      businessAccountId,
      senderPhone: cleanPhone,
      rawMessage: text,
      status: "message_only",
      direction: "outgoing",
    });
  } catch (err) {
    console.error(`[WA Session] Failed to store outgoing template message:`, err);
  }
}

export function isSessionExpiredError(error: any): boolean {
  if (!error) return false;
  const errorStr = typeof error === "string" ? error : JSON.stringify(error);
  return errorStr.includes("131047") || errorStr.includes("Re-engagement");
}

export async function sendWithSessionCheck(
  settings: WhatsappSettings,
  recipientPhone: string,
  message: string,
  sendNormalMessage: (settings: WhatsappSettings, phone: string, msg: string, contextId?: string) => Promise<{ success: boolean; messageId?: string; error?: string }>,
  contextMessageId?: string
): Promise<{ success: boolean; messageId?: string; error?: string; usedTemplate?: boolean }> {
  const sessionActive = await isSessionActive(settings.businessAccountId, recipientPhone);

  if (sessionActive) {
    const result = await sendNormalMessage(settings, recipientPhone, message, contextMessageId);

    if (!result.success && result.error && isSessionExpiredError(result.error)) {
      console.log(`[WA Session] Got 131047 error, session expired — falling back to template`);
      await markSessionExpired(settings.businessAccountId, recipientPhone);
      return await sendTemplateFallback(settings, recipientPhone);
    }

    return result;
  }

  console.log(`[WA Session] Session expired for ${recipientPhone} — sending template`);
  return await sendTemplateFallback(settings, recipientPhone);
}

async function sendTemplateFallback(
  settings: WhatsappSettings,
  recipientPhone: string
): Promise<{ success: boolean; messageId?: string; error?: string; usedTemplate?: boolean }> {
  const templateName = settings.sessionTemplateName;
  if (!templateName) {
    console.error(`[WA Session] No session template configured for business ${settings.businessAccountId} — cannot send re-engagement message`);
    return {
      success: false,
      error: "WhatsApp 24-hour session expired and no re-engagement template is configured. Please configure a template in WhatsApp settings.",
      usedTemplate: false,
    };
  }

  const templateResult = await sendTemplateMessage(settings, recipientPhone, templateName);
  return { ...templateResult, usedTemplate: true };
}
