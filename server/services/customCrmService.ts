import crypto from 'crypto';
import { CustomCrmSettings, CustomCrmFieldMapping, CrmStoreCredential } from '@shared/schema';
import { decrypt } from './encryptionService';

function validateUrl(baseUrl: string, endpoint: string): { valid: boolean; error?: string; fullUrl: string } {
  const fullUrl = `${baseUrl}${endpoint}`;
  try {
    const parsed = new URL(fullUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS protocols are allowed', fullUrl };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname.endsWith('.local') || hostname.startsWith('10.') || hostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      return { valid: false, error: 'Private/internal network addresses are not allowed', fullUrl };
    }
    return { valid: true, fullUrl };
  } catch {
    return { valid: false, error: 'Invalid URL format', fullUrl };
  }
}

export interface DocumentFile {
  url: string;
  fileName?: string;
  mimeType?: string;
}

export interface CustomCrmLeadContext {
  lead: {
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    loanAmount?: string | null;
    address?: string | null;
    loanType?: string | null;
    senderPhone?: string | null;
  };
  extracted?: Record<string, string | null>;
  documents?: Record<string, DocumentFile[]>;
  storeCredential?: CrmStoreCredential;
}

export function resolveFieldValue(
  sourceType: string,
  sourceField: string | null,
  customValue: string | null,
  leadContext: CustomCrmLeadContext
): string | undefined {
  if (sourceType === 'custom') {
    return customValue || undefined;
  }

  if (sourceType === 'store' && sourceField && leadContext.storeCredential) {
    const cred = leadContext.storeCredential;
    switch (sourceField) {
      case 'store.sid': return cred.sid || undefined;
      case 'store.storeName': return cred.storeName || undefined;
      case 'store.dealerName': return cred.dealerName || undefined;
      case 'store.city': return cred.city || undefined;
      case 'store.storeId': return cred.storeId ? String(cred.storeId) : undefined;
    }
  }

  if (sourceType === 'dynamic' && sourceField) {
    const [category, field] = sourceField.split('.');

    if (category === 'lead') {
      const lead = leadContext.lead;
      switch (field) {
        case 'customerName': return lead.customerName || undefined;
        case 'customerEmail': return lead.customerEmail || undefined;
        case 'customerPhone': return lead.customerPhone || undefined;
        case 'loanAmount': return lead.loanAmount || undefined;
        case 'address': return lead.address || undefined;
        case 'loanType': return lead.loanType || undefined;
        case 'senderPhone': return lead.senderPhone || undefined;
      }
    } else if (category === 'extracted' && leadContext.extracted) {
      const val = leadContext.extracted[field];
      return val || undefined;
    } else if (category === 'document' && leadContext.documents) {
      const parts = sourceField.split('.');
      const docType = parts[1];
      if (!docType) return undefined;
      const modifier = parts[2];
      const docs = leadContext.documents[docType];
      if (!docs || docs.length === 0) return undefined;

      if (modifier === 'all') {
        return docs.map(d => d.url).filter(Boolean).join(',');
      }
      return docs[0]?.url || undefined;
    }
  }

  return undefined;
}

export function buildPayload(
  settings: CustomCrmSettings,
  fieldMappings: CustomCrmFieldMapping[],
  leadContext: CustomCrmLeadContext
): Record<string, string> {
  const payload: Record<string, string> = {};

  const enabledMappings = fieldMappings
    .filter(m => m.isEnabled === 'true')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const mapping of enabledMappings) {
    const value = resolveFieldValue(
      mapping.sourceType,
      mapping.sourceField,
      mapping.customValue,
      leadContext
    );
    if (value !== undefined) {
      payload[mapping.crmField] = value;
    }
  }

  return payload;
}

const CAPRION_FIELD_MAP: Record<string, string> = {
  'Name': 'name',
  'name': 'name',
  'Mobile': 'contact_number',
  'mobile': 'contact_number',
  'phone': 'contact_number',
  'Phone': 'contact_number',
  'Email': 'email',
  'email': 'email',
  'loan_amount': 'loanamount',
  'loanAmount': 'loanamount',
  'loanamount': 'loanamount',
  'date_of_birth': 'dob',
  'dateOfBirth': 'dob',
  'dob': 'dob',
  'scheme_name': 'schemeId',
  'scheme_id': 'schemeId',
  'schemeId': 'schemeId',
  'pan': 'pan',
  'PAN': 'pan',
  'gender': 'gender',
  'Gender': 'gender',
  'current_address': 'house_address',
  'address': 'house_address',
  'house_address': 'house_address',
  'permanent_address': 'house_second_address',
  'house_second_address': 'house_second_address',
  'pincode': 'pincode',
  'city': 'city',
  'state': 'State',
  'State': 'State',
  'sid': 'sid',
  'aadhaar': 'aadhaar_number',
  'Aadhaar': 'aadhaar_number',
  'aadhaar_number': 'aadhaar_number',
  'account_no.': 'account_number',
  'account_number': 'account_number',
  'ifsc_code': 'ifsc',
  'ifsc': 'ifsc',
  'monthly_salary': 'monthly_income',
  'monthly_income': 'monthly_income',
  'occupation': 'occupation',
  'company_name': 'company_name',
};

const CAPRION_ACCEPTED_FIELDS = new Set([
  'sid', 'name', 'email', 'contact_number', 'mobile', 'pan', 'gender', 'dob',
  'loanamount', 'callback', 'Timestamp', 'Checksum', 'house_address',
  'house_second_address', 'pincode', 'city', 'State', 'schemeId', 'URN', 'UDF',
  'edit_name', 'edit_email', 'edit_mobile', 'edit_gender', 'edit_house_address',
  'edit_pincode', 'edit_city', 'edit_state', 'edit_dob',
  'aadhaar_number', 'monthly_income', 'occupation', 'company_name',
]);

export function transformPayloadForCaprion(payload: Record<string, string>): Record<string, string> {
  const transformed: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    const mappedKey = CAPRION_FIELD_MAP[key] || key;
    if (CAPRION_ACCEPTED_FIELDS.has(mappedKey)) {
      transformed[mappedKey] = value;
    } else {
      console.log(`[Caprion] Dropping unmapped field: ${key}`);
    }
  }
  return transformed;
}

export function generateChecksumHmac(
  payload: Record<string, string>,
  secretKey: string
): string {
  const sortedKeys = Object.keys(payload).sort();
  const values = sortedKeys.map(k => payload[k]);
  const dataString = values.join('||');

  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(dataString);
  return hmac.digest('hex');
}

export function generateCaprionChecksum(
  payload: Record<string, string>,
  secretKey: string
): string {
  const sortedKeys = Object.keys(payload).sort();
  const values = sortedKeys.map(k => String(payload[k] ?? '').trim());
  const dataString = values.join('||');
  const stringWithSecret = dataString + secretKey;

  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(stringWithSecret);
  return hmac.digest('hex');
}

export function verifyCaprionWebhookChecksum(
  loanId: string,
  loanAmount: string,
  urn: string,
  status: string,
  timestamp: string,
  receivedChecksum: string,
  secretKey: string
): boolean {
  if (!receivedChecksum || typeof receivedChecksum !== 'string') return false;
  const cleaned = receivedChecksum.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleaned)) return false;

  const dataString = `${loanId}|${loanAmount}|${urn}|${status}|${timestamp}`;
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(dataString);
  const computed = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(cleaned, 'hex'));
  } catch {
    return false;
  }
}

export interface SyncLeadResult {
  success: boolean;
  leadId?: string;
  applicationId?: string;
  applicantId?: string;
  message: string;
  payload?: Record<string, string>;
  responseData?: any;
}

export async function syncLead(
  settings: CustomCrmSettings,
  fieldMappings: CustomCrmFieldMapping[],
  leadContext: CustomCrmLeadContext,
  storeCredential?: CrmStoreCredential
): Promise<SyncLeadResult> {
  try {
    if (storeCredential) {
      leadContext.storeCredential = storeCredential;
    }

    const payload = buildPayload(settings, fieldMappings, leadContext);

    if (Object.keys(payload).length === 0) {
      return {
        success: false,
        message: 'No field mappings configured or no data available for sync',
      };
    }

    let secretForChecksum: string | undefined;

    if (settings.authType === 'checksum_caprion') {
      if (!storeCredential) {
        return {
          success: false,
          message: 'Caprion auth requires a matched store credential. Ensure the lead has a store_name that matches a configured store.',
          payload,
        };
      }
      try {
        secretForChecksum = decrypt(storeCredential.secret);
      } catch (e) {
        console.error('[CustomCRM] Failed to decrypt store secret:', e);
        return { success: false, message: 'Failed to decrypt store credential secret' };
      }
    } else if (settings.authType === 'checksum_hmac') {
      if (storeCredential) {
        try {
          secretForChecksum = decrypt(storeCredential.secret);
        } catch (e) {
          console.error('[CustomCRM] Failed to decrypt store secret:', e);
          return { success: false, message: 'Failed to decrypt store credential secret' };
        }
      } else if (settings.authKey) {
        try {
          secretForChecksum = decrypt(settings.authKey);
        } catch (e) {
          console.error('[CustomCRM] Failed to decrypt authKey:', e);
          return { success: false, message: 'Failed to decrypt authentication key' };
        }
      }
    }

    let decryptedAuthKey: string | undefined;
    if (settings.authKey) {
      try {
        decryptedAuthKey = decrypt(settings.authKey);
      } catch (e) {
        console.error('[CustomCRM] Failed to decrypt authKey:', e);
        return { success: false, message: 'Failed to decrypt authentication key' };
      }
    }

    if (settings.authType === 'checksum_caprion' && storeCredential) {
      if (!payload['sid'] && storeCredential.sid) {
        payload['sid'] = storeCredential.sid;
      }
    }

    if (settings.authType === 'checksum_caprion') {
      const caprionPayload = transformPayloadForCaprion(payload);
      if (!caprionPayload['Timestamp']) {
        caprionPayload['Timestamp'] = Math.floor(Date.now() / 1000).toString();
      }
      if (!caprionPayload['callback']) {
        if (settings.callbackUrl) {
          caprionPayload['callback'] = settings.callbackUrl;
        } else {
          const appDomain = process.env.APP_DOMAIN || process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0] || '';
          if (appDomain) {
            caprionPayload['callback'] = `https://${appDomain}/api/custom-crm/caprion-callback`;
            console.warn('[Caprion] No callback URL configured — using default app domain callback.');
          } else {
            caprionPayload['callback'] = settings.apiBaseUrl || 'https://localhost/callback';
            console.warn('[Caprion] WARNING: No callback URL configured and no app domain available. Using fallback. Please set a Callback URL in CRM Settings.');
          }
        }
      }
      Object.keys(payload).forEach(k => delete payload[k]);
      Object.assign(payload, caprionPayload);
      console.log(`[Caprion] Transformed payload fields: ${Object.keys(payload).join(', ')}`);
    }

    if (settings.authType === 'checksum_caprion' && secretForChecksum) {
      payload['Checksum'] = generateCaprionChecksum(payload, secretForChecksum);
    } else if (settings.authType === 'checksum_hmac' && secretForChecksum) {
      payload['Checksum'] = generateChecksumHmac(payload, secretForChecksum);
    }

    const urlValidation = validateUrl(settings.apiBaseUrl || '', settings.apiEndpoint || '');
    if (!urlValidation.valid) {
      return { success: false, message: urlValidation.error || 'Invalid API URL', payload };
    }
    const url = urlValidation.fullUrl;

    const headers: Record<string, string> = {};

    if (settings.authType === 'api_key' && decryptedAuthKey) {
      const headerName = settings.authHeaderName || 'X-Api-Key';
      headers[headerName] = decryptedAuthKey;
    } else if (settings.authType === 'bearer' && decryptedAuthKey) {
      headers['Authorization'] = `Bearer ${decryptedAuthKey}`;
    }

    let response: Response;
    const method = settings.httpMethod || 'POST';

    if (settings.relayUrl) {
      // Route through India relay server instead of calling CRM directly
      // Strip trailing slash and any accidental /relay suffix before appending /relay
      const relayBase = settings.relayUrl.replace(/\/relay\/?$/, '').replace(/\/$/, '');
      const relayEndpoint = relayBase + '/relay';
      console.log(`[CustomCRM] Routing via relay: ${relayEndpoint} → ${url}`);

      const relayHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const relaySecret = process.env.CUSTOM_CRM_RELAY_SECRET;
      if (relaySecret) {
        relayHeaders['Authorization'] = `Bearer ${relaySecret}`;
      }

      const relayBody: Record<string, unknown> = {
        targetUrl: url,
        method,
        headers,
      };

      if (settings.contentType === 'json') {
        // JSON path: send serialised body string — relay forwards as application/json
        relayBody.body = JSON.stringify(payload);
        relayBody.contentType = 'application/json';
      } else {
        // Form-data path: send raw key-value object as `fields` so the relay can
        // reconstruct a proper multipart/form-data request using the FormData API.
        // This is intentionally different from `body` (a pre-serialised string) and
        // preserves the exact wire format that Caprion and other CRMs expect —
        // the relay sets the multipart boundary automatically, identical to the
        // direct-fetch path (relay-server.js handles contentType === 'form-data').
        relayBody.fields = payload;
        relayBody.contentType = 'form-data';
      }

      response = await fetch(relayEndpoint, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify(relayBody),
      });
    } else if (settings.contentType === 'json') {
      headers['Content-Type'] = 'application/json';
      response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
      });
    } else {
      const formData = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        formData.append(key, value);
      }
      response = await fetch(url, {
        method,
        headers,
        body: formData,
      });
    }

    const responseText = await response.text();
    console.log(`[CustomCRM] Response status: ${response.status} - Body: ${responseText.slice(0, 500)}`);

    let responseData: any;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (!response.ok) {
      const errorMsg = responseData?.message || responseData?.error || responseData?.ExceptionMessage || `HTTP ${response.status} ${response.statusText}`;
      return {
        success: false,
        message: `CRM sync failed: ${errorMsg}`,
        payload,
        responseData,
      };
    }

    if (responseData?.success === 0 || responseData?.success === '0' || responseData?.success === false) {
      const errorMsg = responseData?.message || responseData?.error || 'CRM returned failure response';
      return {
        success: false,
        message: `CRM sync failed: ${errorMsg}`,
        payload,
        responseData,
      };
    }

    const nestedData = responseData?.data;
    const dataObj = Array.isArray(nestedData) ? nestedData[0] : (nestedData && typeof nestedData === 'object' ? nestedData : null);

    const leadId = responseData?.id || responseData?.Id || responseData?.leadId || responseData?.lead_id
      || dataObj?.id || dataObj?.Id || dataObj?.leadId || dataObj?.lead_id || undefined;
    const applicationId = responseData?.ApplicationId || responseData?.application_id || responseData?.applicationId
      || dataObj?.ApplicationId || dataObj?.application_id || dataObj?.applicationId || undefined;
    const applicantId = responseData?.ApplicantId || responseData?.applicant_id || responseData?.applicantId
      || dataObj?.ApplicantId || dataObj?.applicant_id || dataObj?.applicantId || undefined;

    return {
      success: true,
      leadId: leadId ? String(leadId) : undefined,
      applicationId: applicationId ? String(applicationId) : undefined,
      applicantId: applicantId ? String(applicantId) : undefined,
      message: `Lead synced successfully to ${settings.name || 'Custom CRM'}`,
      payload,
      responseData,
    };
  } catch (error: any) {
    console.error('[CustomCRM] syncLead error:', error);
    return {
      success: false,
      message: error.message || 'Failed to sync lead to Custom CRM',
    };
  }
}

export interface DocumentUploadResult {
  documentType: string;
  success: boolean;
  message: string;
  responseData?: any;
}

export async function uploadDocumentsToCaprion(
  settings: CustomCrmSettings,
  applicationId: string,
  applicantId: string,
  documents: Record<string, DocumentFile[]>,
  storeCredential: CrmStoreCredential,
  documentTypeMapping?: Record<string, string>
): Promise<DocumentUploadResult[]> {
  const results: DocumentUploadResult[] = [];

  const defaultDocTypeMap: Record<string, string> = {
    'pan': 'PAN Card',
    'pan_card': 'PAN Card',
    'aadhaar': 'Aadhaar Card',
    'aadhaar_card': 'Aadhaar Card',
    'aadhar': 'Aadhaar Card',
    'bank_statement': 'Bank Statement',
    'bankstatement': 'Bank Statement',
    'salary_slip': 'Salary Slip',
    'salaryslip': 'Salary Slip',
    'itr': 'ITR',
    'optransactionhistory': 'Bank Statement',
    'op_transaction_history': 'Bank Statement',
    'transaction_history': 'Bank Statement',
    'bank_passbook': 'Bank Passbook',
    'address_proof': 'Address Proof',
    'photo': 'Photo',
    'photograph': 'Photo',
    'signature': 'Signature',
    'cheque': 'Cancelled Cheque',
    'cancelled_cheque': 'Cancelled Cheque',
    'form_16': 'Form 16',
    'form16': 'Form 16',
    'gst_certificate': 'GST Certificate',
    'business_proof': 'Business Proof',
    'property_document': 'Property Document',
    'cibil': 'CIBIL Report',
    'cibil_report': 'CIBIL Report',
    'voter_id': 'Voter ID',
    'driving_license': 'Driving License',
    'passport': 'Passport',
  };

  const docTypeMap = { ...defaultDocTypeMap, ...documentTypeMapping };

  let decryptedSecret: string;
  try {
    decryptedSecret = decrypt(storeCredential.secret);
  } catch (e) {
    console.error('[CustomCRM] Failed to decrypt store secret for doc upload:', e);
    return [{
      documentType: 'all',
      success: false,
      message: 'Failed to decrypt store credential secret',
    }];
  }

  const uploadEndpoint = (settings.apiBaseUrl || '').replace(/\/$/, '') + '/api/apiintegration/v4/UploadDocument';

  const urlValidation = validateUrl(uploadEndpoint, '');
  if (!urlValidation.valid) {
    return [{
      documentType: 'all',
      success: false,
      message: urlValidation.error || 'Invalid upload URL',
    }];
  }

  for (const [docCategory, files] of Object.entries(documents)) {
    const caprionDocType = docTypeMap[docCategory.toLowerCase()] || docCategory;

    for (const file of files) {
      try {
        const fileUrlValidation = validateUrl(file.url, '');
        if (!fileUrlValidation.valid) {
          results.push({
            documentType: caprionDocType,
            success: false,
            message: `Invalid document URL: ${fileUrlValidation.error}`,
          });
          continue;
        }

        console.log(`[CustomCRM] Uploading document: ${caprionDocType} from ${file.url}`);

        const fileResponse = await fetch(file.url);
        if (!fileResponse.ok) {
          results.push({
            documentType: caprionDocType,
            success: false,
            message: `Failed to download document from ${file.url}: HTTP ${fileResponse.status}`,
          });
          continue;
        }

        const fileBlob = await fileResponse.blob();
        const fileName = file.fileName || `${docCategory}_document.${file.mimeType?.split('/')[1] || 'jpg'}`;

        const metaPayload: Record<string, string> = {
          sid: storeCredential.sid,
          application_id: applicationId,
          applicant_id: applicantId,
          document_type: caprionDocType,
        };

        console.log(`[Caprion DocUpload] Payload fields: ${JSON.stringify(metaPayload)}`);
        const checksum = generateCaprionChecksum(metaPayload, decryptedSecret);

        const formData = new FormData();
        for (const [key, value] of Object.entries(metaPayload)) {
          formData.append(key, value);
        }
        formData.append('Checksum', checksum);
        formData.append('Remarks', `${caprionDocType} uploaded via WhatsApp`);
        formData.append('Files[]', fileBlob, fileName);

        const response = await fetch(uploadEndpoint, {
          method: 'POST',
          body: formData,
        });

        const responseText = await response.text();
        console.log(`[CustomCRM] Document upload response (${caprionDocType}): ${response.status} - ${responseText.slice(0, 300)}`);

        let responseData: any;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          responseData = { raw: responseText };
        }

        if (response.ok) {
          results.push({
            documentType: caprionDocType,
            success: true,
            message: `${caprionDocType} uploaded successfully`,
            responseData,
          });
        } else {
          const errorMsg = responseData?.message || responseData?.error || responseData?.ExceptionMessage || `HTTP ${response.status}`;
          results.push({
            documentType: caprionDocType,
            success: false,
            message: `Failed to upload ${caprionDocType}: ${errorMsg}`,
            responseData,
          });
        }
      } catch (error: any) {
        console.error(`[CustomCRM] Document upload error (${caprionDocType}):`, error);
        results.push({
          documentType: caprionDocType,
          success: false,
          message: error.message || `Failed to upload ${caprionDocType}`,
        });
      }
    }
  }

  return results;
}

async function uploadBankingDetailsToCaprion(
  settings: CustomCrmSettings,
  applicationId: string,
  accountNumber: string | null | undefined,
  ifscCode: string | null | undefined,
  storeCredential: CrmStoreCredential
): Promise<{ success: boolean; message: string }> {
  if (!accountNumber && !ifscCode) {
    return { success: false, message: 'No banking data to upload' };
  }

  let decryptedSecret: string;
  try {
    decryptedSecret = decrypt(storeCredential.secret);
  } catch (e) {
    console.error('[CustomCRM] Failed to decrypt store secret for banking upload:', e);
    return { success: false, message: 'Failed to decrypt store credential secret' };
  }

  const bankingEndpoint = (settings.apiBaseUrl || '').replace(/\/$/, '') + '/api/apiintegration/v4/Add/BankingDetails';

  const urlValidation = validateUrl(bankingEndpoint, '');
  if (!urlValidation.valid) {
    return { success: false, message: urlValidation.error || 'Invalid banking API URL' };
  }

  const payload: Record<string, string> = {
    sid: storeCredential.sid || '',
    applicationId,
    Timestamp: Math.floor(Date.now() / 1000).toString(),
  };
  if (accountNumber) payload['banking_details.account_number'] = accountNumber;
  if (ifscCode) payload['banking_details.ifsc'] = ifscCode;

  payload['Checksum'] = generateCaprionChecksum(payload, decryptedSecret);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      formData.append(key, value);
    }

    console.log(`[CustomCRM] Uploading banking details for AppId: ${applicationId}`);
    const response = await fetch(bankingEndpoint, { method: 'POST', body: formData });
    const responseText = await response.text();

    if (response.ok) {
      console.log(`[CustomCRM] Banking details uploaded successfully: ${responseText.slice(0, 200)}`);
      return { success: true, message: 'Banking details uploaded successfully' };
    } else {
      console.error(`[CustomCRM] Banking details upload failed (${response.status}): ${responseText.slice(0, 300)}`);
      return { success: false, message: `Banking upload failed with status ${response.status}: ${responseText.slice(0, 200)}` };
    }
  } catch (e: any) {
    console.error('[CustomCRM] Banking details upload error:', e);
    return { success: false, message: e.message || 'Banking upload request failed' };
  }
}

export async function syncLeadWithDocuments(
  settings: CustomCrmSettings,
  fieldMappings: CustomCrmFieldMapping[],
  leadContext: CustomCrmLeadContext,
  storeCredential?: CrmStoreCredential
): Promise<SyncLeadResult & { documentResults?: DocumentUploadResult[]; bankingResult?: { success: boolean; message: string } }> {
  const leadResult = await syncLead(settings, fieldMappings, leadContext, storeCredential);

  if (!leadResult.success) {
    return leadResult;
  }

  let finalResult: SyncLeadResult & { documentResults?: DocumentUploadResult[]; bankingResult?: { success: boolean; message: string } } = { ...leadResult };

  if (settings.authType === 'checksum_caprion' && storeCredential && leadResult.applicationId) {
    const extracted = leadContext.extracted || {};

    // Banking details — separate endpoint
    const accountNumber = extracted['account_number'] || extracted['account_no.'] || extracted['account_no'] || null;
    const ifscCode = extracted['ifsc'] || extracted['ifsc_code'] || null;

    if (accountNumber || ifscCode) {
      console.log(`[CustomCRM] Lead created (AppId: ${leadResult.applicationId}), uploading banking details`);
      const bankingResult = await uploadBankingDetailsToCaprion(
        settings,
        leadResult.applicationId,
        accountNumber,
        ifscCode,
        storeCredential
      );
      const bankingSuffix = bankingResult.success ? ' | banking details uploaded' : ` | banking upload failed: ${bankingResult.message}`;
      finalResult = { ...finalResult, message: finalResult.message + bankingSuffix, bankingResult };
    }

    // Document uploads
    if (leadResult.applicantId && leadContext.documents && Object.keys(leadContext.documents).length > 0) {
      console.log(`[CustomCRM] Uploading ${Object.keys(leadContext.documents).length} document type(s)`);

      const documentResults = await uploadDocumentsToCaprion(
        settings,
        leadResult.applicationId,
        leadResult.applicantId,
        leadContext.documents,
        storeCredential
      );

      const successCount = documentResults.filter(r => r.success).length;
      const failCount = documentResults.filter(r => !r.success).length;
      const docSummary = failCount > 0
        ? ` (${successCount} docs uploaded, ${failCount} failed)`
        : ` (${successCount} docs uploaded)`;

      finalResult = { ...finalResult, message: finalResult.message + docSummary, documentResults };
    }
  }

  return finalResult;
}

export async function testConnection(
  settings: CustomCrmSettings
): Promise<{ success: boolean; message: string }> {
  try {
    const urlValidation = validateUrl(settings.apiBaseUrl || '', settings.apiEndpoint || '');
    if (!urlValidation.valid) {
      return { success: false, message: urlValidation.error || 'Invalid API URL' };
    }
    const url = urlValidation.fullUrl;

    let decryptedAuthKey: string | undefined;
    if (settings.authKey) {
      try {
        decryptedAuthKey = decrypt(settings.authKey);
      } catch (e) {
        console.error('[CustomCRM] Failed to decrypt authKey for test:', e);
        return { success: false, message: 'Failed to decrypt authentication key' };
      }
    }

    const headers: Record<string, string> = {};

    if (settings.authType === 'api_key' && decryptedAuthKey) {
      const headerName = settings.authHeaderName || 'X-Api-Key';
      headers[headerName] = decryptedAuthKey;
    } else if (settings.authType === 'bearer' && decryptedAuthKey) {
      headers['Authorization'] = `Bearer ${decryptedAuthKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return {
        success: true,
        message: `Endpoint is reachable (HTTP ${response.status})`,
      };
    } catch (fetchError: any) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        return { success: false, message: 'Connection timed out after 10 seconds' };
      }
      throw fetchError;
    }
  } catch (error: any) {
    console.error('[CustomCRM] testConnection error:', error);
    return {
      success: false,
      message: error.message || 'Failed to connect to CRM endpoint',
    };
  }
}
