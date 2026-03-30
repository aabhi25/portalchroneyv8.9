import type { User } from "../schema";
import type { BusinessAccountDto, ProductTier, SystemMode } from "./businessAccount";

// MeResponseDto - Response type for /api/auth/me endpoint
export type MeResponseDto = User & {
  activeBusinessAccountId?: string | null; // For multi-account switching
  businessAccount?: {
    id: string;
    name: string;
    status: string;
    productTier: ProductTier;
    systemMode: SystemMode;
    shopifyEnabled: boolean;
    appointmentsEnabled: boolean;
    voiceModeEnabled: boolean;
    jewelryShowcaseEnabled: boolean;
    supportTicketsEnabled: boolean;
    whatsappEnabled: boolean;
    instagramEnabled: boolean;
    facebookEnabled: boolean;
    chroneyEnabled: boolean;
    k12EducationEnabled: boolean;
    jobPortalEnabled: boolean;
  } | null;
};

// Convert User with optional BusinessAccount to MeResponseDto
export function toMeResponseDto(
  user: User,
  businessAccount?: BusinessAccountDto | null,
  activeBusinessAccountId?: string | null
): MeResponseDto {
  if (businessAccount) {
    return {
      ...user,
      activeBusinessAccountId: activeBusinessAccountId || null,
      businessAccount: {
        id: businessAccount.id,
        name: businessAccount.name,
        status: businessAccount.status,
        productTier: businessAccount.productTier,
        systemMode: businessAccount.systemMode,
        shopifyEnabled: businessAccount.shopifyEnabled,
        appointmentsEnabled: businessAccount.appointmentsEnabled,
        voiceModeEnabled: businessAccount.voiceModeEnabled,
        jewelryShowcaseEnabled: businessAccount.jewelryShowcaseEnabled,
        supportTicketsEnabled: businessAccount.supportTicketsEnabled,
        whatsappEnabled: businessAccount.whatsappEnabled,
        instagramEnabled: businessAccount.instagramEnabled,
        facebookEnabled: businessAccount.facebookEnabled,
        chroneyEnabled: businessAccount.chroneyEnabled,
        k12EducationEnabled: businessAccount.k12EducationEnabled,
        jobPortalEnabled: businessAccount.jobPortalEnabled,
      },
    };
  }
  
  return {
    ...user,
    activeBusinessAccountId: activeBusinessAccountId || null,
    businessAccount: null,
  };
}
