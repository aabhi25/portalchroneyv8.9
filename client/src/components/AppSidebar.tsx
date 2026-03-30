import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Package, HelpCircle, ShieldCheck, LogOut, Contact, Home, Building2, Sparkles, Settings, Brain, BarChart3, MessageSquare, ShoppingBag, Calendar, GraduationCap, ChevronRight, Presentation, FileText, Key, LifeBuoy, ClipboardList, Route, Link2, Users, DollarSign, Percent, HardDrive, Gem, Image, Database, Camera, Cloud, Globe, Lightbulb, MessageCircle, MoreHorizontal, Bot, TrendingUp, Zap, BookOpen, Library, HelpCircle as QuizIcon, Briefcase, UserCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import type { MeResponseDto } from "@shared/dto";

interface AppSidebarProps {
  user: MeResponseDto | null;
}

function NavItem({ icon: Icon, label, onClick, isActive, badge, testId, gradient }: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  isActive: boolean;
  badge?: number;
  testId?: string;
  gradient?: string;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={isActive}
        data-testid={testId}
        className={`group/nav relative transition-all duration-200 ${
          isActive
            ? 'bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 font-medium shadow-sm border border-purple-100/60'
            : 'hover:bg-gray-50/80'
        }`}
      >
        <div className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-200 ${
          isActive
            ? (gradient || 'bg-gradient-to-br from-purple-500 to-indigo-600')
            : 'bg-gray-100 group-hover/nav:bg-gray-200/80'
        }`}>
          <Icon className={`w-3.5 h-3.5 transition-colors ${isActive ? 'text-white' : 'text-gray-500 group-hover/nav:text-gray-700'}`} />
        </div>
        <span className="text-[14px]">{label}</span>
        {badge && badge > 0 ? (
          <Badge variant="destructive" className="ml-auto text-[10px] px-1.5 py-0 h-5 min-w-5 flex items-center justify-center" data-testid="badge-ticket-count">
            {badge}
          </Badge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ user }: AppSidebarProps) {
  const [location, setLocation] = useLocation();

  const isSuperAdmin = user?.role === "super_admin";
  const isSuperAdminImpersonating = isSuperAdmin && !!user?.activeBusinessAccountId;
  const isGroupAdmin = user?.role === "account_group_admin";
  const showBusinessNav = (!isSuperAdmin && !isGroupAdmin) || isSuperAdminImpersonating;
  
  const productTier = user?.businessAccount?.productTier || 'chroney';
  const hasChroneyAccess = user?.businessAccount?.chroneyEnabled === true;
  const hasJewelryAccess = productTier === 'jewelry_showcase' || productTier === 'jewelry_showcase_chroney';
  
  const hasShopifyEnabled = user?.businessAccount?.shopifyEnabled === true;
  const hasAppointmentsEnabled = user?.businessAccount?.appointmentsEnabled === true && hasChroneyAccess;
  const hasSupportTicketsEnabled = user?.businessAccount?.supportTicketsEnabled === true;
  const hasJewelryShowcaseEnabled = hasJewelryAccess && (
    productTier === 'jewelry_showcase' || 
    user?.businessAccount?.jewelryShowcaseEnabled === true
  );
  const hasWhatsappEnabled = user?.businessAccount?.whatsappEnabled === true;
  const hasInstagramEnabled = user?.businessAccount?.instagramEnabled === true;
  const hasFacebookEnabled = user?.businessAccount?.facebookEnabled === true;
  
  const hasTrainingAccess = hasChroneyAccess || hasWhatsappEnabled || hasInstagramEnabled || hasFacebookEnabled;
  const hasProductsAccess = hasChroneyAccess || hasWhatsappEnabled || hasJewelryAccess;
  
  const systemMode = user?.businessAccount?.systemMode || 'full';
  const showFullFeatures = isSuperAdminImpersonating || systemMode === 'full';
  const isEducationK12 = user?.businessAccount?.k12EducationEnabled === true;
  const isJobPortal = user?.businessAccount?.jobPortalEnabled === true;

  const enabledAgentCount = [hasChroneyAccess, hasWhatsappEnabled, hasInstagramEnabled, hasFacebookEnabled].filter(Boolean).length;
  const isSingleProduct = enabledAgentCount === 1;
  const hasAnyAgent = hasChroneyAccess || hasWhatsappEnabled || hasInstagramEnabled || hasFacebookEnabled;
  const hasWorkspaceItems = (hasTrainingAccess && showFullFeatures) || hasProductsAccess || hasAppointmentsEnabled || hasJewelryShowcaseEnabled;

  const { data: ticketStats } = useQuery<{ open: number }>({
    queryKey: ["/api/tickets/stats"],
    enabled: showBusinessNav && !!user,
  });
  
  const openTicketCount = ticketStats?.open || 0;

  const handleLogout = async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
      sessionStorage.removeItem("lastPath");
      queryClient.clear();
      window.location.href = "/";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <Sidebar className="border-r-0 sidebar-ocean">
      <SidebarHeader className="p-4 border-b border-gray-100/80">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden">
            <img src="/c_logo.png" className="w-10 h-10 object-contain" alt="AI Chroney" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-sm bg-gradient-to-r from-purple-700 to-indigo-600 bg-clip-text text-transparent">AI Chroney</h2>
            {showBusinessNav && user?.businessAccountId && user?.businessAccount?.name ? (
              <AccountSwitcher 
                businessName={user.businessAccount.name}
                businessAccountId={user.businessAccountId}
              />
            ) : (
              <p className="text-xs text-gray-400 font-medium">{user?.username}</p>
            )}
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {showBusinessNav && (
          <>
            {isJobPortal ? (
              <>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu className="space-y-0.5">
                      <NavItem
                        icon={Home}
                        label="Home"
                        onClick={() => setLocation("/")}
                        isActive={location === "/"}
                        testId="link-home"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup>
                  <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-3 mb-1">Recruitment</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="space-y-0.5">
                      <NavItem
                        icon={Briefcase}
                        label="Jobs"
                        onClick={() => setLocation("/admin/jobs")}
                        isActive={location === "/admin/jobs"}
                        testId="link-jobs"
                        gradient="bg-gradient-to-br from-cyan-500 to-blue-600"
                      />
                      <NavItem
                        icon={UserCircle}
                        label="Applicants"
                        onClick={() => setLocation("/admin/applicants")}
                        isActive={location === "/admin/applicants"}
                        testId="link-applicants"
                        gradient="bg-gradient-to-br from-teal-500 to-cyan-600"
                      />
                      <NavItem
                        icon={MessageSquare}
                        label="Conversations"
                        onClick={() => setLocation("/conversations")}
                        isActive={location === "/conversations"}
                        testId="link-conversations"
                        gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                      />
                      <NavItem
                        icon={Contact}
                        label="Leads"
                        onClick={() => setLocation("/admin/leads")}
                        isActive={location === "/admin/leads"}
                        testId="link-leads"
                        gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                      />
                      <NavItem
                        icon={BarChart3}
                        label="Insights"
                        onClick={() => setLocation("/insights")}
                        isActive={location === "/insights"}
                        testId="link-insights"
                        gradient="bg-gradient-to-br from-purple-500 to-violet-600"
                      />
                      <NavItem
                        icon={Settings}
                        label="Widget"
                        onClick={() => setLocation("/admin/widget-settings")}
                        isActive={location === "/admin/widget-settings"}
                        testId="link-widget"
                        gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                      />
                      <NavItem
                        icon={GraduationCap}
                        label="Training"
                        onClick={() => setLocation("/admin/training")}
                        isActive={location === "/admin/training" || location === "/train-chroney" || location === "/conversation-journeys" || location === "/admin/faqs" || location === "/admin/about" || location === "/admin/scan-docs" || location === "/admin/url-training"}
                        testId="link-training"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </>
            ) : isEducationK12 ? (
              <>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu className="space-y-0.5">
                      <NavItem
                        icon={Home}
                        label="Home"
                        onClick={() => setLocation("/")}
                        isActive={location === "/"}
                        testId="link-home"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup>
                  <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-3 mb-1">Education</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="space-y-0.5">
                      <NavItem
                        icon={BookOpen}
                        label="Content"
                        onClick={() => setLocation("/admin/k12/content")}
                        isActive={location.startsWith("/admin/k12/content") || location.startsWith("/admin/k12/topic")}
                        testId="link-k12-content"
                        gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                      />
                      <NavItem
                        icon={MessageSquare}
                        label="Conversations"
                        onClick={() => setLocation("/conversations")}
                        isActive={location === "/conversations"}
                        testId="link-conversations"
                        gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                      />
                      <NavItem
                        icon={Contact}
                        label="Students"
                        onClick={() => setLocation("/admin/leads")}
                        isActive={location === "/admin/leads"}
                        testId="link-students"
                        gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                      />
                      <NavItem
                        icon={BarChart3}
                        label="Insights"
                        onClick={() => setLocation("/insights")}
                        isActive={location === "/insights"}
                        testId="link-insights"
                        gradient="bg-gradient-to-br from-purple-500 to-violet-600"
                      />
                      <NavItem
                        icon={Settings}
                        label="Widget"
                        onClick={() => setLocation("/admin/widget-settings")}
                        isActive={location === "/admin/widget-settings"}
                        testId="link-widget"
                        gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                      />
                      <NavItem
                        icon={GraduationCap}
                        label="Training"
                        onClick={() => setLocation("/admin/training")}
                        isActive={location === "/admin/training" || location === "/train-chroney" || location === "/conversation-journeys" || location === "/admin/faqs" || location === "/admin/about" || location === "/admin/scan-docs" || location === "/admin/url-training"}
                        testId="link-training"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </>
            ) : (
            <>
            {hasChroneyAccess && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={Home}
                      label="Home"
                      onClick={() => setLocation("/")}
                      isActive={location === "/"}
                      testId="link-home"
                      gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {hasJewelryShowcaseEnabled && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={Gem}
                      label="Vista Search"
                      onClick={() => setLocation("/jewelry-showcase")}
                      isActive={location === "/jewelry-showcase"}
                      testId="link-jewelry-showcase"
                      gradient="bg-gradient-to-br from-pink-500 to-rose-600"
                    />
                    <NavItem
                      icon={Camera}
                      label="Vista Studio"
                      onClick={() => setLocation("/admin/jewelry-image-generator")}
                      isActive={location === "/admin/jewelry-image-generator"}
                      testId="link-vista-studio"
                      gradient="bg-gradient-to-br from-amber-500 to-orange-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {hasAnyAgent && !isSingleProduct && (
              <SidebarGroup>
                <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-3 mb-1">AI Agents</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    {hasChroneyAccess && (
                      <NavItem
                        icon={Globe}
                        label="Website"
                        onClick={() => setLocation("/admin/website")}
                        isActive={location === "/admin/website" || location === "/conversations" || location === "/admin/leads" || location === "/tickets" || location.startsWith("/tickets/") || location === "/insights" || location === "/admin/widget-settings"}
                        testId="link-website-agent"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    )}

                    {hasWhatsappEnabled && (
                      <NavItem
                        icon={MessageSquare}
                        label="WhatsApp"
                        onClick={() => setLocation("/admin/whatsapp")}
                        isActive={location.startsWith("/admin/whatsapp") || location.startsWith("/admin/wa-")}
                        testId="link-whatsapp"
                        gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                      />
                    )}

                    {hasInstagramEnabled && (
                      <NavItem
                        icon={Camera}
                        label="Instagram"
                        onClick={() => setLocation("/admin/instagram")}
                        isActive={location.startsWith("/admin/instagram")}
                        testId="link-instagram"
                        gradient="bg-gradient-to-br from-pink-500 via-purple-500 to-orange-400"
                      />
                    )}

                    {hasFacebookEnabled && (
                      <NavItem
                        icon={MessageCircle}
                        label="Facebook"
                        onClick={() => setLocation("/admin/facebook")}
                        isActive={location.startsWith("/admin/facebook")}
                        testId="link-facebook"
                        gradient="bg-gradient-to-br from-blue-600 to-blue-500"
                      />
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {isSingleProduct && hasChroneyAccess && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={MessageSquare}
                      label="Conversations"
                      onClick={() => setLocation("/conversations")}
                      isActive={location === "/conversations"}
                      testId="link-conversations"
                      gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                    />
                    <NavItem
                      icon={Contact}
                      label="Leads"
                      onClick={() => setLocation("/admin/leads")}
                      isActive={location === "/admin/leads"}
                      testId="link-leads"
                      gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                    />
                    {hasSupportTicketsEnabled && showFullFeatures && (
                      <NavItem
                        icon={LifeBuoy}
                        label="Tickets"
                        onClick={() => setLocation("/tickets")}
                        isActive={location === "/tickets" || location.startsWith("/tickets/")}
                        testId="link-tickets"
                        badge={openTicketCount > 0 ? openTicketCount : undefined}
                        gradient="bg-gradient-to-br from-rose-500 to-pink-600"
                      />
                    )}
                    <NavItem
                      icon={BarChart3}
                      label="Insights"
                      onClick={() => setLocation("/insights")}
                      isActive={location === "/insights"}
                      testId="link-insights"
                      gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                    />
                    <NavItem
                      icon={Settings}
                      label="Widget"
                      onClick={() => setLocation("/admin/widget-settings")}
                      isActive={location === "/admin/widget-settings"}
                      testId="link-widget"
                      gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {isSingleProduct && hasWhatsappEnabled && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={MessageSquare}
                      label="Conversations"
                      onClick={() => setLocation("/admin/whatsapp-conversations")}
                      isActive={location === "/admin/whatsapp-conversations"}
                      testId="link-wa-conversations"
                      gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                    />
                    <NavItem
                      icon={Contact}
                      label="Leads"
                      onClick={() => setLocation("/admin/whatsapp-leads")}
                      isActive={location === "/admin/whatsapp-leads"}
                      testId="link-wa-leads"
                      gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                    />
                    <NavItem
                      icon={Route}
                      label="Flows"
                      onClick={() => setLocation("/admin/whatsapp-flows")}
                      isActive={location === "/admin/whatsapp-flows" || location === "/admin/whatsapp-flow-settings"}
                      testId="link-wa-flows"
                      gradient="bg-gradient-to-br from-purple-500 to-violet-600"
                    />
                    <NavItem
                      icon={BarChart3}
                      label="Insights"
                      onClick={() => setLocation("/admin/wa-insights")}
                      isActive={location === "/admin/wa-insights"}
                      testId="link-wa-insights"
                      gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                    />
                    <NavItem
                      icon={Settings}
                      label="Config"
                      onClick={() => setLocation("/admin/whatsapp-config")}
                      isActive={location === "/admin/whatsapp-config"}
                      testId="link-wa-config"
                      gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                    />
                    <NavItem
                      icon={ShieldCheck}
                      label="Whitelist"
                      onClick={() => setLocation("/admin/whatsapp-whitelist")}
                      isActive={location === "/admin/whatsapp-whitelist"}
                      testId="link-wa-whitelist"
                      gradient="bg-gradient-to-br from-teal-500 to-emerald-600"
                    />
                    <NavItem
                      icon={Zap}
                      label="Smart Replies"
                      onClick={() => setLocation("/admin/whatsapp-smart-replies")}
                      isActive={location === "/admin/whatsapp-smart-replies"}
                      testId="link-wa-smart-replies"
                      gradient="bg-gradient-to-br from-amber-500 to-orange-600"
                    />
                    <NavItem
                      icon={Link2}
                      label="CRM"
                      onClick={() => setLocation("/admin/crm")}
                      isActive={location === "/admin/crm" || location === "/admin/leadsquared" || location === "/admin/salesforce" || location === "/admin/custom-crm"}
                      testId="link-wa-crm"
                      gradient="bg-gradient-to-br from-indigo-500 to-purple-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {isSingleProduct && hasInstagramEnabled && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={MessageSquare}
                      label="Conversations"
                      onClick={() => setLocation("/admin/instagram-conversations")}
                      isActive={location === "/admin/instagram-conversations"}
                      testId="link-ig-conversations"
                      gradient="bg-gradient-to-br from-pink-500 to-purple-600"
                    />
                    <NavItem
                      icon={Contact}
                      label="Leads"
                      onClick={() => setLocation("/admin/instagram-leads")}
                      isActive={location === "/admin/instagram-leads"}
                      testId="link-ig-leads"
                      gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                    />
                    <NavItem
                      icon={Route}
                      label="Flows"
                      onClick={() => setLocation("/admin/instagram-flows")}
                      isActive={location === "/admin/instagram-flows"}
                      testId="link-ig-flows"
                      gradient="bg-gradient-to-br from-purple-500 to-violet-600"
                    />
                    <NavItem
                      icon={BarChart3}
                      label="Insights"
                      onClick={() => setLocation("/admin/instagram-insights")}
                      isActive={location === "/admin/instagram-insights"}
                      testId="link-ig-insights"
                      gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                    />
                    <NavItem
                      icon={MessageCircle}
                      label="Comments"
                      onClick={() => setLocation("/admin/instagram-comments")}
                      isActive={location === "/admin/instagram-comments"}
                      testId="link-ig-comments"
                      gradient="bg-gradient-to-br from-rose-500 to-pink-600"
                    />
                    <NavItem
                      icon={Settings}
                      label="Settings"
                      onClick={() => setLocation("/admin/instagram-settings")}
                      isActive={location === "/admin/instagram-settings"}
                      testId="link-ig-settings"
                      gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {isSingleProduct && hasFacebookEnabled && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={MessageSquare}
                      label="Conversations"
                      onClick={() => setLocation("/admin/facebook-conversations")}
                      isActive={location === "/admin/facebook-conversations"}
                      testId="link-fb-conversations"
                      gradient="bg-gradient-to-br from-blue-600 to-blue-500"
                    />
                    <NavItem
                      icon={Contact}
                      label="Leads"
                      onClick={() => setLocation("/admin/facebook-leads")}
                      isActive={location === "/admin/facebook-leads"}
                      testId="link-fb-leads"
                      gradient="bg-gradient-to-br from-green-500 to-emerald-600"
                    />
                    <NavItem
                      icon={Route}
                      label="Flows"
                      onClick={() => setLocation("/admin/facebook-flows")}
                      isActive={location === "/admin/facebook-flows"}
                      testId="link-fb-flows"
                      gradient="bg-gradient-to-br from-purple-500 to-violet-600"
                    />
                    <NavItem
                      icon={BarChart3}
                      label="Insights"
                      onClick={() => setLocation("/admin/facebook-insights")}
                      isActive={location === "/admin/facebook-insights"}
                      testId="link-fb-insights"
                      gradient="bg-gradient-to-br from-orange-500 to-amber-600"
                    />
                    <NavItem
                      icon={MessageCircle}
                      label="Comments"
                      onClick={() => setLocation("/admin/facebook-comments")}
                      isActive={location === "/admin/facebook-comments"}
                      testId="link-fb-comments"
                      gradient="bg-gradient-to-br from-rose-500 to-pink-600"
                    />
                    <NavItem
                      icon={Settings}
                      label="Settings"
                      onClick={() => setLocation("/admin/facebook-settings")}
                      isActive={location === "/admin/facebook-settings"}
                      testId="link-fb-settings"
                      gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {hasWorkspaceItems && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    {hasTrainingAccess && showFullFeatures && (
                      <NavItem
                        icon={GraduationCap}
                        label="Training"
                        onClick={() => setLocation("/admin/training")}
                        isActive={location === "/admin/training" || location === "/train-chroney" || location === "/conversation-journeys" || location === "/admin/faqs" || location === "/admin/about" || location === "/admin/scan-docs" || location === "/admin/url-training"}
                        testId="link-training"
                        gradient="bg-gradient-to-br from-violet-500 to-purple-600"
                      />
                    )}

                    {hasProductsAccess && !hasShopifyEnabled && (
                      <NavItem
                        icon={Package}
                        label="Products"
                        onClick={() => setLocation("/admin/products")}
                        isActive={location === "/admin/products"}
                        testId="link-products"
                        gradient="bg-gradient-to-br from-amber-500 to-yellow-600"
                      />
                    )}
                    {hasProductsAccess && hasShopifyEnabled && (
                      <NavItem
                        icon={ShoppingBag}
                        label="Shopify"
                        onClick={() => setLocation("/admin/shopify")}
                        isActive={location === "/admin/shopify"}
                        testId="link-shopify"
                        gradient="bg-gradient-to-br from-green-600 to-lime-600"
                      />
                    )}

                    {hasAppointmentsEnabled && (
                      <NavItem
                        icon={Calendar}
                        label="Calendar"
                        onClick={() => setLocation("/admin/calendar")}
                        isActive={location === "/admin/calendar"}
                        testId="link-calendar"
                        gradient="bg-gradient-to-br from-teal-500 to-cyan-600"
                      />
                    )}

                    {hasJewelryShowcaseEnabled && (
                      <>
                        <NavItem
                          icon={Image}
                          label="Match History"
                          onClick={() => setLocation("/admin/uploads")}
                          isActive={location === "/admin/uploads"}
                          testId="link-uploads"
                          gradient="bg-gradient-to-br from-rose-500 to-pink-600"
                        />
                        <NavItem
                          icon={BarChart3}
                          label="Analytics"
                          onClick={() => setLocation("/vista-insights")}
                          isActive={location === "/vista-insights"}
                          testId="link-analytics"
                          gradient="bg-gradient-to-br from-blue-500 to-indigo-600"
                        />
                      </>
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {hasChroneyAccess && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu className="space-y-0.5">
                    <NavItem
                      icon={MoreHorizontal}
                      label="More"
                      onClick={() => setLocation("/admin/more")}
                      isActive={location === "/admin/more" || location.startsWith("/admin/menu-builder") || location === "/ai-insights" || location === "/question-bank" || location === "/admin/smart-discounts" || location.startsWith("/guidance-campaigns") || location === "/admin/crm" || location === "/admin/leadsquared" || location === "/admin/salesforce" || location === "/admin/custom-crm"}
                      testId="link-more"
                      gradient="bg-gradient-to-br from-gray-500 to-slate-600"
                    />
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
            </>
            )}
          </>
        )}

        {isSuperAdmin && !isSuperAdminImpersonating ? (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-3 mb-1">Super Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="space-y-0.5">
                <NavItem icon={ShieldCheck} label="Business Accounts" onClick={() => setLocation("/super-admin")} isActive={location === "/super-admin"} testId="link-super-admin" gradient="bg-gradient-to-br from-purple-500 to-violet-600" />
                <NavItem icon={BarChart3} label="Insights" onClick={() => setLocation("/super-admin/insights")} isActive={location === "/super-admin/insights"} testId="link-super-admin-insights" gradient="bg-gradient-to-br from-blue-500 to-indigo-600" />
                <NavItem icon={DollarSign} label="Cost Analytics" onClick={() => setLocation("/super-admin/costs")} isActive={location === "/super-admin/costs"} testId="link-super-admin-costs" gradient="bg-gradient-to-br from-emerald-500 to-green-600" />
                <NavItem icon={Presentation} label="Demo" onClick={() => setLocation("/super-admin/demo")} isActive={location === "/super-admin/demo"} testId="link-super-admin-demo" gradient="bg-gradient-to-br from-amber-500 to-orange-600" />
                <NavItem icon={Key} label="API Keys" onClick={() => setLocation("/super-admin/api-keys")} isActive={location === "/super-admin/api-keys"} testId="link-super-admin-api-keys" gradient="bg-gradient-to-br from-rose-500 to-pink-600" />
                <NavItem icon={Bot} label="Chat APIs" onClick={() => setLocation("/super-admin/chat-apis")} isActive={location === "/super-admin/chat-apis"} testId="link-super-admin-chat-apis" gradient="bg-gradient-to-br from-cyan-500 to-teal-600" />
                <NavItem icon={Link2} label="Account Groups" onClick={() => setLocation("/super-admin/account-groups")} isActive={location === "/super-admin/account-groups"} testId="link-super-admin-account-groups" gradient="bg-gradient-to-br from-indigo-500 to-purple-600" />
                <NavItem icon={ClipboardList} label="MIS" onClick={() => setLocation("/super-admin/mis")} isActive={location === "/super-admin/mis"} testId="link-super-admin-mis" gradient="bg-gradient-to-br from-fuchsia-500 to-pink-600" />
                <NavItem icon={Cloud} label="Google Photos" onClick={() => setLocation("/super-admin/google-photos")} isActive={location === "/super-admin/google-photos"} testId="link-super-admin-google-photos" gradient="bg-gradient-to-br from-sky-500 to-blue-600" />
                <NavItem icon={Globe} label="Server Info" onClick={() => setLocation("/super-admin/server-info")} isActive={location === "/super-admin/server-info"} testId="link-super-admin-server-info" gradient="bg-gradient-to-br from-slate-500 to-gray-700" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : isGroupAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold px-3 mb-1">Group Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="space-y-0.5">
                <NavItem icon={Users} label="Leads" onClick={() => setLocation("/group-admin/leads")} isActive={location === "/group-admin/leads"} testId="link-group-admin-leads" gradient="bg-gradient-to-br from-orange-500 to-amber-600" />
                <NavItem icon={MessageSquare} label="Conversations" onClick={() => setLocation("/group-admin/conversations")} isActive={location === "/group-admin/conversations"} testId="link-group-admin-conversations" gradient="bg-gradient-to-br from-emerald-500 to-teal-600" />

                <NavItem icon={Lightbulb} label="Account Insights" onClick={() => setLocation("/group-admin/insights")} isActive={location === "/group-admin/insights"} testId="link-group-admin-insights" gradient="bg-gradient-to-br from-yellow-500 to-amber-600" />
                <NavItem icon={TrendingUp} label="Group Analytics" onClick={() => setLocation("/group-admin/group-analytics")} isActive={location === "/group-admin/group-analytics"} testId="link-group-admin-group-analytics" gradient="bg-gradient-to-br from-purple-500 to-pink-600" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-gray-100/80">
        <SidebarMenu className="space-y-0.5">
          <NavItem
            icon={Settings}
            label="Settings"
            onClick={() => setLocation(isSuperAdmin && !isSuperAdminImpersonating ? "/super-admin/settings" : "/admin/settings")}
            isActive={location === "/admin/settings" || location === "/super-admin/settings"}
            testId="link-settings"
            gradient="bg-gradient-to-br from-slate-500 to-gray-600"
          />
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleLogout}
              data-testid="button-logout"
              className="group/nav transition-all duration-200 hover:bg-red-50/80"
            >
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-100 group-hover/nav:bg-red-100 transition-all duration-200">
                <LogOut className="w-3.5 h-3.5 text-gray-500 group-hover/nav:text-red-500 transition-colors" />
              </div>
              <span className="text-[14px] group-hover/nav:text-red-600 transition-colors">Logout</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
