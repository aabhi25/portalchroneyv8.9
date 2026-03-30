import type { BusinessAccount } from "../schema";

// Product tier type
export type ProductTier = 'chroney' | 'jewelry_showcase' | 'jewelry_showcase_chroney';

// System mode type - controls visible features for business users
export type SystemMode = 'full' | 'essential';

// BusinessAccountDto with normalized boolean feature flags for API/client
export type BusinessAccountDto = Omit<BusinessAccount, "shopifyEnabled" | "appointmentsEnabled" | "voiceModeEnabled" | "visualSearchEnabled" | "jewelryShowcaseEnabled" | "supportTicketsEnabled" | "whatsappEnabled" | "instagramEnabled" | "facebookEnabled" | "chroneyEnabled" | "k12EducationEnabled" | "jobPortalEnabled" | "systemMode"> & {
  shopifyEnabled: boolean;
  appointmentsEnabled: boolean;
  voiceModeEnabled: boolean;
  visualSearchEnabled: boolean;
  jewelryShowcaseEnabled: boolean;
  supportTicketsEnabled: boolean;
  whatsappEnabled: boolean;
  instagramEnabled: boolean;
  facebookEnabled: boolean;
  chroneyEnabled: boolean;
  k12EducationEnabled: boolean;
  jobPortalEnabled: boolean;
  productTier: ProductTier;
  systemMode: SystemMode;
  isLive?: boolean;
};

// Convert database BusinessAccount (text flags) to BusinessAccountDto (boolean flags)
export function toBusinessAccountDto(account: BusinessAccount): BusinessAccountDto {
  return {
    ...account,
    shopifyEnabled: account.shopifyEnabled === "true",
    appointmentsEnabled: account.appointmentsEnabled === "true",
    voiceModeEnabled: account.voiceModeEnabled === "true",
    visualSearchEnabled: account.visualSearchEnabled === "true",
    jewelryShowcaseEnabled: account.jewelryShowcaseEnabled === "true",
    supportTicketsEnabled: account.supportTicketsEnabled === "true",
    whatsappEnabled: account.whatsappEnabled === "true",
    instagramEnabled: account.instagramEnabled === "true",
    facebookEnabled: account.facebookEnabled === "true",
    chroneyEnabled: account.chroneyEnabled === "true",
    k12EducationEnabled: account.k12EducationEnabled === "true",
    jobPortalEnabled: account.jobPortalEnabled === "true",
    productTier: (account.productTier || 'chroney') as ProductTier,
    systemMode: (account.systemMode || 'full') as SystemMode,
  };
}

// Convert BusinessAccountDto (boolean flags) back to database format (text flags)
export function fromBusinessAccountDto(dto: BusinessAccountDto): BusinessAccount {
  return {
    ...dto,
    shopifyEnabled: dto.shopifyEnabled ? "true" : "false",
    appointmentsEnabled: dto.appointmentsEnabled ? "true" : "false",
    voiceModeEnabled: dto.voiceModeEnabled ? "true" : "false",
    visualSearchEnabled: dto.visualSearchEnabled ? "true" : "false",
    jewelryShowcaseEnabled: dto.jewelryShowcaseEnabled ? "true" : "false",
    supportTicketsEnabled: dto.supportTicketsEnabled ? "true" : "false",
    whatsappEnabled: dto.whatsappEnabled ? "true" : "false",
    instagramEnabled: dto.instagramEnabled ? "true" : "false",
    facebookEnabled: dto.facebookEnabled ? "true" : "false",
    chroneyEnabled: dto.chroneyEnabled ? "true" : "false",
    k12EducationEnabled: dto.k12EducationEnabled ? "true" : "false",
    jobPortalEnabled: dto.jobPortalEnabled ? "true" : "false",
    systemMode: dto.systemMode || 'full',
  };
}
