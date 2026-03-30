import OpenAI from "openai";
import { db } from "../db";
import { businessAccounts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { documentTypeService, DocumentTypeConfig } from "./documentTypeService";

const execFileAsync = promisify(execFile);

export interface DocumentIdentificationResult {
  documentType: string;
  confidence: number;
  extractedData: Record<string, any>;
  isValid: boolean;
  validationNotes?: string;
  side?: "front" | "back";
}

export interface PdfExtractionResult {
  success: boolean;
  text?: string;
  isPasswordProtected?: boolean;
  isScannedDocument?: boolean;
  error?: string;
}

class DocumentIdentificationService {
  private async buildSystemPrompt(businessAccountId: string): Promise<string> {
    const docTypes = await documentTypeService.getActiveDocumentTypes(businessAccountId);

    if (docTypes.length === 0) {
      return this.getDefaultSystemPrompt();
    }

    const docTypeDescriptions = docTypes.map((dt) => {
      const fieldList = dt.extractionFields
        .map((f) => `${f.label}${f.required ? " (REQUIRED)" : ""}`)
        .join(", ");
      const customNote = dt.promptTemplate ? ` — ${dt.promptTemplate}` : "";
      return `- ${dt.name.toUpperCase()} (key: "${dt.key}"): ${fieldList}${customNote}`;
    }).join("\n");

    const validTypeKeys = docTypes.map((dt) => `"${dt.key}"`).join(" | ");

    const fieldDescriptions = docTypes.map((dt) => {
      const fields = dt.extractionFields.map((f) => {
        let desc = `    "${f.key}": "${f.label}${f.required ? " (REQUIRED)" : ""}"`;
        if (f.formatDescription) desc += ` // format: ${f.formatDescription}`;
        else if (f.formatRegex) desc += ` // must match: ${f.formatRegex}`;
        return desc;
      }).join(",\n");
      return `  For ${dt.key}:\n${fields}`;
    }).join("\n\n");

    return `You are an expert document identification and extraction AI. Analyze uploaded images/text to:
1. Identify the document type
2. Extract relevant information from the document
3. Validate if the document appears genuine

Configured Document Types and Expected Fields:
${docTypeDescriptions}

Return a JSON object with this exact structure:
{
  "documentType": ${validTypeKeys} | "unknown",
  "confidence": 0.0 to 1.0,
  "extractedData": {
    // Include only keys relevant to the identified document type:
${fieldDescriptions}
  },
  "isValid": true/false,
  "validationNotes": "Any issues or observations about the document",
  "side": "front" | "back"
}

IMPORTANT - Document Side Detection:
- For Aadhaar cards: The FRONT side has the 12-digit Aadhaar number, photo, name, DOB, and gender. The BACK side has the full address, a QR code, and also has the 12-digit Aadhaar number printed on it. Always extract relevant fields from BOTH front and back sides.
- For PAN cards: Usually single-sided, always set side to "front".
- For other documents: Set "front" if it shows the main identifying information, "back" if it shows secondary/supplementary info.
- Always include the "side" field in your response.

Only include fields that are relevant to the identified document type. For any field you cannot find or read, use null.
For unreadable or invalid documents, set confidence low and explain in validationNotes.

IMPORTANT: When the image is NOT a recognized document (documentType is "unknown"), you MUST describe what you actually see in the image in the validationNotes field. Be brief and specific about what is visible.`;
  }

  private getDefaultSystemPrompt(): string {
    return `You are an expert document identification and extraction AI. Analyze uploaded images to:
1. Identify the document type (aadhaar, pan, bank_statement, driving_license, or unknown)
2. Extract relevant information from the document
3. Validate if the document appears genuine

Document Types and Expected Fields:
- AADHAAR Card: 12-digit number, name, date of birth, address, gender
- PAN Card: 10-character alphanumeric (format: ABCDE1234F), name, father's name, date of birth
- Bank Statement: Bank name, account number, IFSC code, statement period
- Driving License: License number, name, date of birth, issue date, expiry date, address

Return a JSON object with this exact structure:
{
  "documentType": "aadhaar" | "pan" | "bank_statement" | "driving_license" | "unknown",
  "confidence": 0.0 to 1.0,
  "extractedData": {
    "name": "...",
    "documentNumber": "...",
    "dateOfBirth": "...",
    "address": "...",
    "fatherName": "...",
    "issueDate": "...",
    "expiryDate": "...",
    "bankName": "...",
    "accountNumber": "...",
    "ifscCode": "..."
  },
  "isValid": true/false,
  "validationNotes": "Any issues or observations about the document",
  "side": "front" | "back"
}

Only include fields that are relevant to the document type. For unreadable or invalid documents, set confidence low and explain in validationNotes.

IMPORTANT: When the image is NOT a recognized document (documentType is "unknown"), you MUST describe what you actually see in the image in the validationNotes field. Be brief and specific about what is visible.`;
  }

  async identifyDocument(
    businessAccountId: string,
    imageUrl: string
  ): Promise<DocumentIdentificationResult> {
    try {
      const [account] = await db
        .select({ openaiApiKey: businessAccounts.openaiApiKey })
        .from(businessAccounts)
        .where(eq(businessAccounts.id, businessAccountId))
        .limit(1);

      const apiKey = account?.openaiApiKey;
      if (!apiKey) {
        console.warn(`[Document ID] OpenAI API key not configured for business ${businessAccountId}`);
        return {
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "OpenAI API key not configured"
        };
      }

      const systemPrompt = await this.buildSystemPrompt(businessAccountId);
      const openai = new OpenAI({ apiKey, timeout: 30000 });

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Identify this document, extract all visible information, and validate its authenticity."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                  detail: "high"
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || "";
      
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[Document ID] No JSON found in response:", content);
        return {
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "Could not parse document"
        };
      }

      const result = JSON.parse(jsonMatch[0]) as DocumentIdentificationResult;
      console.log(`[Document ID] Identified: ${result.documentType} with ${result.confidence} confidence`);
      
      await this.validateAndCorrectDocumentType(result, businessAccountId);
      
      return result;
    } catch (error: any) {
      console.error("[Document ID] Error identifying document:", error);
      const isTimeoutOrNetwork = error.message?.includes("timeout") || 
        error.message?.includes("Timeout") || 
        error.message?.includes("fetch") ||
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("network");
      return {
        documentType: "unknown",
        confidence: 0,
        extractedData: {},
        isValid: false,
        validationNotes: isTimeoutOrNetwork 
          ? "Could not process the image. The file may have expired or failed to load." 
          : "Could not analyze this image. Please try uploading again."
      };
    }
  }

  async extractTextFromPdf(pdfBuffer: Buffer, password?: string): Promise<PdfExtractionResult> {
    let parser: any = null;
    let PasswordException: any = null;
    try {
      const pdfModule = await import("pdf-parse") as any;
      const PDFParse = pdfModule.PDFParse;
      PasswordException = pdfModule.PasswordException;
      const options: any = {
        data: new Uint8Array(pdfBuffer),
        verbosity: 0,
      };
      if (password) {
        options.password = password;
      }
      parser = new PDFParse(options);
      const result = await parser.getText();
      const text = (result?.text || "").trim();
      if (!text || text.length < 10) {
        return {
          success: false,
          isScannedDocument: true,
          error: "PDF contains no readable text. It may be a scanned document."
        };
      }
      return { success: true, text };
    } catch (error: any) {
      if (
        (PasswordException && error instanceof PasswordException) ||
        error.constructor?.name === "PasswordException" ||
        (error.name || "").includes("PasswordException") ||
        (error.message || "").toLowerCase().includes("password") ||
        (error.message || "").toLowerCase().includes("encrypted")
      ) {
        return {
          success: false,
          isPasswordProtected: true,
          error: "PDF is password protected"
        };
      }
      console.error("[Document ID] PDF extraction error:", error.message || error);
      return {
        success: false,
        error: "Could not read this PDF file. Please try uploading a photo of the document instead."
      };
    } finally {
      if (parser) {
        try { parser.destroy(); } catch (_) {}
      }
    }
  }

  async identifyDocumentFromPdfImages(
    businessAccountId: string,
    pdfBuffer: Buffer
  ): Promise<DocumentIdentificationResult[]> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-pages-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');

    try {
      await fs.writeFile(pdfPath, pdfBuffer);

      const outputPrefix = path.join(tmpDir, 'page');
      await execFileAsync('pdftoppm', [
        '-jpeg',
        '-r', '150',
        '-l', '6',
        pdfPath,
        outputPrefix
      ], { timeout: 60000 });

      const files = await fs.readdir(tmpDir);
      const pageFiles = files
        .filter(f => f.startsWith('page') && (f.endsWith('.png') || f.endsWith('.jpg')))
        .sort();

      if (pageFiles.length === 0) {
        console.warn('[Document ID] pdftoppm produced no page images');
        return [{
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "Could not render PDF pages as images"
        }];
      }

      console.log(`[Document ID] Rendered ${pageFiles.length} PDF pages as images, sending to vision AI in parallel`);
      const startTime = Date.now();

      const pageDataUrls = await Promise.all(
        pageFiles.map(async (pageFile) => {
          const pagePath = path.join(tmpDir, pageFile);
          const imageBuffer = await fs.readFile(pagePath);
          const base64Image = imageBuffer.toString('base64');
          const mimeType = pageFile.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
          return { pageFile, dataUrl: `data:${mimeType};base64,${base64Image}` };
        })
      );

      const visionResults = await Promise.all(
        pageDataUrls.map(async ({ pageFile, dataUrl }) => {
          const result = await this.identifyDocument(businessAccountId, dataUrl);
          if (result.documentType !== 'unknown' && result.confidence > 0.3) {
            console.log(`[Document ID] PDF page ${pageFile}: identified ${result.documentType} (confidence: ${result.confidence})`);
          } else {
            console.log(`[Document ID] PDF page ${pageFile}: no document identified (${result.documentType}, confidence: ${result.confidence})`);
          }
          return result;
        })
      );

      const results = visionResults.filter(
        r => r.documentType !== 'unknown' && r.confidence > 0.3
      );
      console.log(`[Document ID] Vision AI parallel processing took ${Date.now() - startTime}ms for ${pageFiles.length} pages, found ${results.length} documents`);

      if (results.length === 0) {
        return [{
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "No recognizable documents found in PDF pages"
        }];
      }

      return results;
    } catch (error: any) {
      console.error('[Document ID] PDF-to-image conversion error:', error.message);
      return [{
        documentType: "unknown",
        confidence: 0,
        extractedData: {},
        isValid: false,
        validationNotes: `Failed to convert PDF to images: ${error.message}`
      }];
    } finally {
      try {
        const files = await fs.readdir(tmpDir);
        for (const f of files) {
          await fs.unlink(path.join(tmpDir, f));
        }
        await fs.rmdir(tmpDir);
      } catch (_) {}
    }
  }

  async identifyDocumentFromText(
    businessAccountId: string,
    text: string
  ): Promise<DocumentIdentificationResult> {
    try {
      const [account] = await db
        .select({ openaiApiKey: businessAccounts.openaiApiKey })
        .from(businessAccounts)
        .where(eq(businessAccounts.id, businessAccountId))
        .limit(1);

      const apiKey = account?.openaiApiKey;
      if (!apiKey) {
        return {
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "OpenAI API key not configured"
        };
      }

      const systemPrompt = await this.buildSystemPrompt(businessAccountId);
      const openai = new OpenAI({ apiKey, timeout: 30000 });
      const truncatedText = text.substring(0, 5000);

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: `Identify this document from its extracted text and extract all relevant information:\n\n${truncatedText}`
          }
        ],
        max_tokens: 1000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          documentType: "unknown",
          confidence: 0,
          extractedData: {},
          isValid: false,
          validationNotes: "Could not parse document text"
        };
      }

      const result = JSON.parse(jsonMatch[0]) as DocumentIdentificationResult;
      console.log(`[Document ID] Identified from text: ${result.documentType} with ${result.confidence} confidence`);
      await this.validateAndCorrectDocumentType(result, businessAccountId);
      return result;
    } catch (error: any) {
      console.error("[Document ID] Error identifying document from text:", error);
      return {
        documentType: "unknown",
        confidence: 0,
        extractedData: {},
        isValid: false,
        validationNotes: "Could not analyze this document. Please try uploading again."
      };
    }
  }

  private static PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  private static AADHAAR_REGEX = /^\d{12}$/;

  private async validateAndCorrectDocumentType(result: DocumentIdentificationResult, businessAccountId: string): Promise<void> {
    if (result.documentType === "unknown") return;

    const docNumber = result.extractedData?.documentNumber || result.extractedData?.aadhaar_number || result.extractedData?.pan_number;
    if (docNumber && result.confidence >= 0.5) {
      const cleanNumber = String(docNumber).replace(/[\s-]/g, '').toUpperCase();
      const isPanFormat = DocumentIdentificationService.PAN_REGEX.test(cleanNumber);
      const isAadhaarFormat = DocumentIdentificationService.AADHAAR_REGEX.test(cleanNumber);

      if (result.documentType === "aadhaar" && isPanFormat && !isAadhaarFormat) {
        console.log(`[Document ID] Format correction: AI said aadhaar but document number "${cleanNumber}" matches PAN format — correcting to pan`);
        result.documentType = "pan";
        result.validationNotes = (result.validationNotes || "") + " [Auto-corrected from aadhaar to pan based on document number format]";
      } else if (result.documentType === "pan" && isAadhaarFormat && !isPanFormat) {
        console.log(`[Document ID] Format correction: AI said pan but document number "${cleanNumber}" matches Aadhaar format — correcting to aadhaar`);
        result.documentType = "aadhaar";
        result.validationNotes = (result.validationNotes || "") + " [Auto-corrected from pan to aadhaar based on document number format]";
      }
    }

    const docTypeConfig = await documentTypeService.getDocumentTypeByKey(businessAccountId, result.documentType);
    if (docTypeConfig) {
      for (const field of docTypeConfig.extractionFields) {
        if (field.formatRegex) {
          const fieldValue = result.extractedData?.[field.key];
          if (fieldValue) {
            const cleanValue = String(fieldValue).replace(/[\s-]/g, '').toUpperCase();
            try {
              const regex = new RegExp(field.formatRegex);
              if (!regex.test(cleanValue)) {
                result.validationNotes = (result.validationNotes || "") + ` [Format warning for ${field.label}: expected ${field.formatDescription || field.formatRegex}]`;
              }
            } catch (_) {}
          }
        }
      }
    }
  }

  async validateDocumentType(
    result: DocumentIdentificationResult,
    expectedTypes: string[]
  ): Promise<{ matches: boolean; matchedType?: string }> {
    if (result.documentType === "unknown") {
      return { matches: false };
    }

    const matches = expectedTypes.includes(result.documentType);
    return {
      matches,
      matchedType: matches ? result.documentType : undefined
    };
  }
}

export const documentIdentificationService = new DocumentIdentificationService();
