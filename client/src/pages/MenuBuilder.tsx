import { useState, useEffect, useRef } from "react";
import MoreFeaturesNavTabs from "@/components/MoreFeaturesNavTabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Trash2, GripVertical, Folder, MessageSquare, ExternalLink, Phone, FileText, Eye, Save, ChevronRight, Pencil, BookOpen, GraduationCap, Briefcase, ShoppingBag, Star, Heart, HelpCircle, ClipboardList } from "lucide-react";
import { DetailsBuilder, DetailsConfig, parseDetailsConfig, stringifyDetailsConfig } from "@/components/DetailsBuilder";

interface MenuItem {
  id: string;
  parentId: string | null;
  title: string;
  subtitle: string | null;
  icon: string;
  iconBgColor: string;
  iconColor: string;
  sortOrder: number;
  itemType: string;
  actionValue: string | null;
  leadFormFields: string | null;
  isActive: string;
}

interface LeadFormFieldConfig {
  visible: boolean;
  required: boolean;
}

interface CustomLeadField {
  id: string;
  label: string;
  fieldType: 'text' | 'dropdown' | 'textarea';
  options: string[];
  required: boolean;
}

interface LeadFormFieldsConfig {
  name?: LeadFormFieldConfig;
  phone?: LeadFormFieldConfig;
  email?: LeadFormFieldConfig;
  custom?: CustomLeadField[];
}

interface MenuConfig {
  id?: string;
  enabled: string;
  welcomeMessage: string;
  avatarUrl: string | null;
  quickChips: { label: string; emoji?: string; action: string; actionValue?: string }[];
  footerText: string | null;
  footerLinkText: string | null;
  footerLinkUrl: string | null;
  persistentCtaEnabled: string;
  persistentCtaLabel: string;
  persistentCtaIcon: string;
  persistentCtaAction: string;
  persistentCtaValue: string | null;
  leadFormFields?: string;
}

const parseLeadFormFields = (str?: string): LeadFormFieldsConfig => {
  if (!str) {
    return { name: { visible: true, required: true }, phone: { visible: true, required: false }, custom: [] };
  }
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed, custom: parsed.custom || [] };
    }
  } catch {
    const fields = str.split(",").filter(f => f);
    const result: LeadFormFieldsConfig = { custom: [] };
    fields.forEach((f, i) => {
      result[f as keyof Omit<LeadFormFieldsConfig, 'custom'>] = { visible: true, required: i === 0 };
    });
    return result;
  }
  return { name: { visible: true, required: true }, phone: { visible: true, required: false }, custom: [] };
};

const stringifyLeadFormFields = (config: LeadFormFieldsConfig): string => {
  return JSON.stringify(config);
};

const iconOptions = [
  { value: "folder", label: "Folder" },
  { value: "message-square", label: "Chat" },
  { value: "phone", label: "Phone" },
  { value: "book-open", label: "Book" },
  { value: "graduation-cap", label: "Graduation Cap" },
  { value: "briefcase", label: "Briefcase" },
  { value: "shopping-bag", label: "Shopping Bag" },
  { value: "star", label: "Star" },
  { value: "heart", label: "Heart" },
  { value: "help-circle", label: "Help" },
];

const getMenuBuilderIcon = (iconName?: string | null) => {
  switch (iconName) {
    case "message-square": return MessageSquare;
    case "phone": return Phone;
    case "book-open": return BookOpen;
    case "graduation-cap": return GraduationCap;
    case "briefcase": return Briefcase;
    case "shopping-bag": return ShoppingBag;
    case "star": return Star;
    case "heart": return Heart;
    case "help-circle": return HelpCircle;
    case "url": return ExternalLink;
    case "file": return FileText;
    default: return Folder;
  }
};

const itemTypeOptions = [
  { value: "navigate", label: "Navigate to Submenu", icon: Folder },
  { value: "chat", label: "Open AI Chat", icon: MessageSquare },
  { value: "url", label: "Open URL", icon: ExternalLink },
  { value: "phone", label: "Call Phone", icon: Phone },
  { value: "form", label: "Open Journey/Form", icon: FileText },
  { value: "lead_form", label: "Open Lead Form", icon: ClipboardList },
  { value: "detail", label: "Show Details", icon: Eye },
];

export default function MenuBuilder() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [localWelcomeMessage, setLocalWelcomeMessage] = useState("");
  const [localFooterText, setLocalFooterText] = useState("");
  const [localFooterLinkText, setLocalFooterLinkText] = useState("");
  const [localFooterLinkUrl, setLocalFooterLinkUrl] = useState("");
  const [localCtaLabel, setLocalCtaLabel] = useState("");
  const [localCtaValue, setLocalCtaValue] = useState("");
  const [showAddCustomField, setShowAddCustomField] = useState(false);
  const [newCustomField, setNewCustomField] = useState<{ label: string; fieldType: 'text' | 'dropdown' | 'textarea'; options: string; required: boolean }>({ label: '', fieldType: 'text', options: '', required: false });
  const [showItemAddCustomField, setShowItemAddCustomField] = useState(false);
  const [newItemCustomField, setNewItemCustomField] = useState<{ label: string; fieldType: 'text' | 'dropdown' | 'textarea'; options: string; required: boolean }>({ label: '', fieldType: 'text', options: '', required: false });
  const configInitialized = useRef(false);

  const { data: config, isLoading: configLoading } = useQuery<MenuConfig>({
    queryKey: ["/api/chat-menu/config"],
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery<MenuItem[]>({
    queryKey: ["/api/chat-menu/items"],
  });

  const { data: widgetSettings } = useQuery<{ chatColor?: string; chatColorEnd?: string; avatarType?: string; avatarUrl?: string }>({
    queryKey: ["/api/widget-settings"],
  });

  const { data: journeys = [] } = useQuery<{ id: string; name: string; journeyType: string; status: string }[]>({
    queryKey: ["/api/journeys"],
  });

  const chatColor = widgetSettings?.chatColor || "#9333ea";
  const chatColorEnd = widgetSettings?.chatColorEnd || "#3b82f6";

  // Initialize all local text fields from config
  useEffect(() => {
    if (config && !configInitialized.current) {
      setLocalWelcomeMessage(config.welcomeMessage || "");
      setLocalFooterText(config.footerText || "");
      setLocalFooterLinkText(config.footerLinkText || "");
      setLocalFooterLinkUrl(config.footerLinkUrl || "");
      setLocalCtaLabel(config.persistentCtaLabel || "");
      setLocalCtaValue(config.persistentCtaValue || "");
      configInitialized.current = true;
    }
  }, [config]);

  // Debounced save for all text fields
  useEffect(() => {
    if (!configInitialized.current) return;
    
    const timer = setTimeout(() => {
      const updates: Partial<MenuConfig> = {};
      
      if (localWelcomeMessage !== (config?.welcomeMessage || "")) {
        updates.welcomeMessage = localWelcomeMessage;
      }
      if (localFooterText !== (config?.footerText || "")) {
        updates.footerText = localFooterText || null;
      }
      if (localFooterLinkText !== (config?.footerLinkText || "")) {
        updates.footerLinkText = localFooterLinkText || null;
      }
      if (localFooterLinkUrl !== (config?.footerLinkUrl || "")) {
        updates.footerLinkUrl = localFooterLinkUrl || null;
      }
      if (localCtaLabel !== (config?.persistentCtaLabel || "")) {
        updates.persistentCtaLabel = localCtaLabel;
      }
      if (localCtaValue !== (config?.persistentCtaValue || "")) {
        updates.persistentCtaValue = localCtaValue || null;
      }
      
      if (Object.keys(updates).length > 0) {
        updateConfigMutation.mutate(updates);
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [localWelcomeMessage, localFooterText, localFooterLinkText, localFooterLinkUrl, localCtaLabel, localCtaValue]);

  const updateConfigMutation = useMutation({
    mutationFn: async (data: Partial<MenuConfig>) => {
      return apiRequest("PUT", "/api/chat-menu/config", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-menu/config"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createItemMutation = useMutation({
    mutationFn: async (data: Partial<MenuItem>) => {
      return apiRequest("POST", "/api/chat-menu/items", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-menu/items"] });
      setIsAddDialogOpen(false);
      toast({ title: "Menu item created" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateItemMutation = useMutation({
    mutationFn: async ({ id, ...data }: Partial<MenuItem> & { id: string }) => {
      return apiRequest("PUT", `/api/chat-menu/items/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-menu/items"] });
      setEditingItem(null);
      toast({ title: "Menu item updated" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/chat-menu/items/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-menu/items"] });
      toast({ title: "Menu item deleted" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const rootItems = items.filter((item) => !item.parentId);
  const getChildren = (parentId: string) => items.filter((item) => item.parentId === parentId);

  const [newItem, setNewItem] = useState({
    title: "",
    subtitle: "",
    icon: "folder",
    iconBgColor: "#E0E7FF",
    iconColor: "#4F46E5",
    itemType: "navigate",
    actionValue: "",
  });

  const handleAddItem = () => {
    createItemMutation.mutate({
      ...newItem,
      parentId: selectedParentId,
      sortOrder: items.filter((i) => i.parentId === selectedParentId).length,
    });
    setNewItem({
      title: "",
      subtitle: "",
      icon: "folder",
      iconBgColor: "#E0E7FF",
      iconColor: "#4F46E5",
      itemType: "navigate",
      actionValue: "",
    });
  };

  if (configLoading || itemsLoading) {
    return (
      <div>
        <MoreFeaturesNavTabs />
        <div className="p-6 flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <MoreFeaturesNavTabs />
      <div className="p-6 max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Menu Builder</h1>
          <p className="text-muted-foreground">
            Create visual navigation menus for your chat widget
          </p>
        </div>

      <Tabs defaultValue="config" className="space-y-6">
        <TabsList>
          <TabsTrigger value="config">Welcome Screen</TabsTrigger>
          <TabsTrigger value="items">Menu Items</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Menu Mode</CardTitle>
                  <CardDescription>
                    Enable menu-based navigation instead of direct chat
                  </CardDescription>
                </div>
                <Switch
                  checked={config?.enabled === "true"}
                  onCheckedChange={(checked) =>
                    updateConfigMutation.mutate({ enabled: checked ? "true" : "false" })
                  }
                />
              </div>
            </CardHeader>
          </Card>

          {config?.enabled === "true" && (<>
          <Card>
            <CardHeader>
              <CardTitle>Welcome Message</CardTitle>
              <CardDescription>
                The greeting shown at the top of the menu
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Message</Label>
                <Textarea
                  value={localWelcomeMessage}
                  onChange={(e) => {
                    if (e.target.value.length <= 100) {
                      setLocalWelcomeMessage(e.target.value);
                    }
                  }}
                  maxLength={100}
                  placeholder="Hi! How can I help you today?"
                />
                <p className="text-xs text-muted-foreground text-right">
                  {localWelcomeMessage.length}/100
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Persistent CTA</CardTitle>
              <CardDescription>
                A button that stays visible at the bottom of the menu
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Enable Persistent CTA</Label>
                <Switch
                  checked={config?.persistentCtaEnabled === "true"}
                  onCheckedChange={(checked) =>
                    updateConfigMutation.mutate({
                      persistentCtaEnabled: checked ? "true" : "false",
                    })
                  }
                />
              </div>
              {config?.persistentCtaEnabled === "true" && (
                <>
                  <div className="space-y-2">
                    <Label>Button Label</Label>
                    <Input
                      value={localCtaLabel}
                      onChange={(e) => setLocalCtaLabel(e.target.value)}
                      placeholder="Talk to Counsellor"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Action Type</Label>
                    <Select
                      value={config?.persistentCtaAction || "chat"}
                      onValueChange={(value) =>
                        updateConfigMutation.mutate({ persistentCtaAction: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chat">Open Chat</SelectItem>
                        <SelectItem value="url">Open URL</SelectItem>
                        <SelectItem value="phone">Call Phone</SelectItem>
                        <SelectItem value="lead_form">Open Lead Form</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {config?.persistentCtaAction === "phone" && (
                    <div className="space-y-2">
                      <Label>Phone Number</Label>
                      <Input
                        value={localCtaValue}
                        onChange={(e) => setLocalCtaValue(e.target.value)}
                        placeholder="+1234567890"
                      />
                    </div>
                  )}
                  {config?.persistentCtaAction === "url" && (
                    <div className="space-y-2">
                      <Label>URL</Label>
                      <Input
                        value={localCtaValue}
                        onChange={(e) => setLocalCtaValue(e.target.value)}
                        placeholder="https://example.com"
                      />
                    </div>
                  )}
                  {config?.persistentCtaAction === "lead_form" && (
                    <div className="space-y-3">
                      <Label>Fields to Capture</Label>
                      <div className="space-y-3">
                        {[
                          { key: "name", label: "Name" },
                          { key: "phone", label: "Mobile Number" },
                          { key: "email", label: "Email" },
                        ].map((field) => {
                          const fieldKey = field.key as keyof Omit<LeadFormFieldsConfig, 'custom'>;
                          const fieldsConfig = parseLeadFormFields(config?.leadFormFields);
                          const fieldConfig = fieldsConfig[fieldKey] as LeadFormFieldConfig | undefined;
                          const isVisible = fieldConfig?.visible ?? false;
                          const isRequired = fieldConfig?.required ?? false;
                          
                          return (
                            <div key={field.key} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                              <div className="flex items-center gap-3">
                                <input
                                  type="checkbox"
                                  id={`lead-field-${field.key}`}
                                  checked={isVisible}
                                  onChange={(e) => {
                                    const newConfig = { ...fieldsConfig };
                                    if (e.target.checked) {
                                      newConfig[fieldKey] = { visible: true, required: false };
                                    } else {
                                      delete newConfig[fieldKey];
                                    }
                                    const standardKeys = Object.keys(newConfig).filter(k => k !== 'custom');
                                    if (standardKeys.length === 0 && (newConfig.custom || []).length === 0) {
                                      newConfig.name = { visible: true, required: true };
                                    }
                                    updateConfigMutation.mutate({ leadFormFields: stringifyLeadFormFields(newConfig) });
                                  }}
                                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                />
                                <label htmlFor={`lead-field-${field.key}`} className="text-sm text-gray-700">
                                  {field.label}
                                </label>
                              </div>
                              {isVisible && (
                                <div className="flex items-center gap-2">
                                  <label htmlFor={`lead-field-required-${field.key}`} className="text-xs text-gray-500">
                                    Required
                                  </label>
                                  <Switch
                                    id={`lead-field-required-${field.key}`}
                                    checked={isRequired}
                                    onCheckedChange={(checked) => {
                                      const newConfig = { ...fieldsConfig };
                                      newConfig[fieldKey] = { visible: true, required: checked };
                                      updateConfigMutation.mutate({ leadFormFields: stringifyLeadFormFields(newConfig) });
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="mt-4 space-y-2">
                        <p className="text-sm font-medium text-gray-700">Custom Fields</p>
                        {(parseLeadFormFields(config?.leadFormFields).custom || []).map((field) => (
                          <div key={field.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm text-gray-800 truncate">{field.label}</span>
                              <span className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded capitalize shrink-0">{field.fieldType}</span>
                              {field.required && <span className="text-xs text-red-500 shrink-0">Required</span>}
                            </div>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              <Switch
                                checked={field.required}
                                onCheckedChange={(checked) => {
                                  const fieldsConfig = parseLeadFormFields(config?.leadFormFields);
                                  const newCustom = (fieldsConfig.custom || []).map(f =>
                                    f.id === field.id ? { ...f, required: checked } : f
                                  );
                                  updateConfigMutation.mutate({ leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                }}
                              />
                              <label className="text-xs text-gray-500">Req.</label>
                              <button
                                type="button"
                                onClick={() => {
                                  const fieldsConfig = parseLeadFormFields(config?.leadFormFields);
                                  const newCustom = (fieldsConfig.custom || []).filter(f => f.id !== field.id);
                                  updateConfigMutation.mutate({ leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                }}
                                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          </div>
                        ))}

                        {showAddCustomField ? (
                          <div className="mt-2 p-3 border border-purple-200 rounded-lg bg-purple-50 space-y-3">
                            <div>
                              <label className="text-xs font-medium text-gray-700 block mb-1">Field Label</label>
                              <Input
                                value={newCustomField.label}
                                onChange={(e) => setNewCustomField(prev => ({ ...prev, label: e.target.value }))}
                                placeholder="e.g. Course you are looking for"
                                className="text-sm"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-gray-700 block mb-1">Field Type</label>
                              <Select
                                value={newCustomField.fieldType}
                                onValueChange={(v) => setNewCustomField(prev => ({ ...prev, fieldType: v as 'text' | 'dropdown' | 'textarea' }))}
                              >
                                <SelectTrigger className="text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="text">Text</SelectItem>
                                  <SelectItem value="dropdown">Dropdown</SelectItem>
                                  <SelectItem value="textarea">Textarea</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            {newCustomField.fieldType === 'dropdown' && (
                              <div>
                                <label className="text-xs font-medium text-gray-700 block mb-1">Options (one per line)</label>
                                <Textarea
                                  value={newCustomField.options}
                                  onChange={(e) => setNewCustomField(prev => ({ ...prev, options: e.target.value }))}
                                  placeholder={"MBA\nBCA\nMCA\nBBA"}
                                  rows={4}
                                  className="text-sm"
                                />
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={newCustomField.required}
                                onCheckedChange={(checked) => setNewCustomField(prev => ({ ...prev, required: checked }))}
                              />
                              <label className="text-xs text-gray-600">Required</label>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  if (!newCustomField.label.trim()) return;
                                  const fieldsConfig = parseLeadFormFields(config?.leadFormFields);
                                  const options = newCustomField.fieldType === 'dropdown'
                                    ? newCustomField.options.split('\n').map(o => o.trim()).filter(Boolean)
                                    : [];
                                  const newField: CustomLeadField = {
                                    id: crypto.randomUUID(),
                                    label: newCustomField.label.trim(),
                                    fieldType: newCustomField.fieldType,
                                    options,
                                    required: newCustomField.required,
                                  };
                                  const newCustom = [...(fieldsConfig.custom || []), newField];
                                  updateConfigMutation.mutate({ leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                  setShowAddCustomField(false);
                                  setNewCustomField({ label: '', fieldType: 'text', options: '', required: false });
                                }}
                                className="text-xs"
                              >
                                Save Field
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setShowAddCustomField(false);
                                  setNewCustomField({ label: '', fieldType: 'text', options: '', required: false });
                                }}
                                className="text-xs"
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowAddCustomField(true)}
                            className="flex items-center gap-1.5 text-sm text-purple-600 hover:text-purple-800 font-medium mt-1"
                          >
                            <Plus className="w-4 h-4" />
                            Add Custom Field
                          </button>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground mt-2">
                        Standard fields collect contact info. Custom fields capture additional details (e.g. course interest) which are saved as Topics of Interest.
                      </p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Footer</CardTitle>
              <CardDescription>
                Optional footer text with a link
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Footer Text</Label>
                <Input
                  value={localFooterText}
                  onChange={(e) => setLocalFooterText(e.target.value)}
                  placeholder="Are you an existing customer?"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Link Text</Label>
                  <Input
                    value={localFooterLinkText}
                    onChange={(e) => setLocalFooterLinkText(e.target.value)}
                    placeholder="Login to your account"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Link URL</Label>
                  <Input
                    value={localFooterLinkUrl}
                    onChange={(e) => setLocalFooterLinkUrl(e.target.value)}
                    placeholder="https://example.com/login"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
          </>)}
        </TabsContent>

        {config?.enabled === "true" && (
        <TabsContent value="items" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Menu Items</CardTitle>
                  <CardDescription>
                    Create and organize your menu structure
                  </CardDescription>
                </div>
                <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button onClick={() => setSelectedParentId(null)}>
                      <Plus className="w-4 h-4 mr-2" />
                      Add Item
                    </Button>
                  </DialogTrigger>
                  <DialogContent className={newItem.itemType === "detail" ? "max-w-2xl max-h-[90vh] overflow-y-auto" : ""}>
                    <DialogHeader>
                      <DialogTitle>Add Menu Item</DialogTitle>
                      <DialogDescription>
                        Create a new menu item for your chat widget
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Title</Label>
                        <Input
                          value={newItem.title}
                          onChange={(e) =>
                            setNewItem({ ...newItem, title: e.target.value })
                          }
                          placeholder="Browse Courses"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Subtitle</Label>
                        <Input
                          value={newItem.subtitle}
                          onChange={(e) =>
                            setNewItem({ ...newItem, subtitle: e.target.value })
                          }
                          placeholder="Explore our course catalog"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Icon</Label>
                        <Select
                          value={newItem.icon}
                          onValueChange={(value) =>
                            setNewItem({ ...newItem, icon: value })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {iconOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Icon Background</Label>
                          <Input
                            type="color"
                            value={newItem.iconBgColor}
                            onChange={(e) =>
                              setNewItem({ ...newItem, iconBgColor: e.target.value })
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Icon Color</Label>
                          <Input
                            type="color"
                            value={newItem.iconColor}
                            onChange={(e) =>
                              setNewItem({ ...newItem, iconColor: e.target.value })
                            }
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Action Type</Label>
                        <Select
                          value={newItem.itemType}
                          onValueChange={(value) =>
                            setNewItem({ ...newItem, itemType: value, actionValue: value === "chat" || value === "navigate" || value === "lead_form" ? "" : newItem.actionValue })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {itemTypeOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {newItem.itemType !== "navigate" && newItem.itemType !== "chat" && newItem.itemType !== "detail" && newItem.itemType !== "form" && newItem.itemType !== "lead_form" && (
                        <div className="space-y-2">
                          <Label>Action Value</Label>
                          <Input
                            value={newItem.actionValue}
                            onChange={(e) =>
                              setNewItem({ ...newItem, actionValue: e.target.value })
                            }
                            placeholder={
                              newItem.itemType === "url"
                                ? "https://example.com"
                                : newItem.itemType === "phone"
                                ? "+1234567890"
                                : ""
                            }
                          />
                        </div>
                      )}
                      {newItem.itemType === "form" && (
                        <div className="space-y-2">
                          <Label>Journey / Form</Label>
                          <Select
                            value={newItem.actionValue || ""}
                            onValueChange={(value) =>
                              setNewItem({ ...newItem, actionValue: value })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a journey..." />
                            </SelectTrigger>
                            <SelectContent>
                              {journeys.filter(j => j.status === "active").map((journey) => (
                                <SelectItem key={journey.id} value={journey.id}>
                                  {journey.name} ({journey.journeyType})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      {newItem.itemType === "detail" && (
                        <DetailsBuilder
                          value={parseDetailsConfig(newItem.actionValue)}
                          onChange={(config) =>
                            setNewItem({ ...newItem, actionValue: stringifyDetailsConfig(config) })
                          }
                        />
                      )}
                      {selectedParentId && (
                        <div className="p-3 bg-muted rounded-lg text-sm">
                          Adding as child of:{" "}
                          <strong>
                            {items.find((i) => i.id === selectedParentId)?.title}
                          </strong>
                        </div>
                      )}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleAddItem} disabled={!newItem.title}>
                        Add Item
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Edit Dialog */}
                <Dialog open={!!editingItem} onOpenChange={(open) => { if (!open) { setEditingItem(null); setShowItemAddCustomField(false); setNewItemCustomField({ label: '', fieldType: 'text', options: '', required: false }); } }}>
                  <DialogContent className={editingItem?.itemType === "detail" || editingItem?.itemType === "lead_form" ? "max-w-2xl max-h-[90vh] overflow-y-auto" : ""}>
                    <DialogHeader>
                      <DialogTitle>Edit Menu Item</DialogTitle>
                      <DialogDescription>
                        Update the menu item details
                      </DialogDescription>
                    </DialogHeader>
                    {editingItem && (
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Title</Label>
                          <Input
                            value={editingItem.title}
                            onChange={(e) =>
                              setEditingItem({ ...editingItem, title: e.target.value })
                            }
                            placeholder="Browse Courses"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Subtitle</Label>
                          <Input
                            value={editingItem.subtitle || ""}
                            onChange={(e) =>
                              setEditingItem({ ...editingItem, subtitle: e.target.value })
                            }
                            placeholder="Explore our course catalog"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Icon</Label>
                          <Select
                            value={editingItem.icon}
                            onValueChange={(value) =>
                              setEditingItem({ ...editingItem, icon: value })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {iconOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Icon Background</Label>
                            <Input
                              type="color"
                              value={editingItem.iconBgColor}
                              onChange={(e) =>
                                setEditingItem({ ...editingItem, iconBgColor: e.target.value })
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Icon Color</Label>
                            <Input
                              type="color"
                              value={editingItem.iconColor}
                              onChange={(e) =>
                                setEditingItem({ ...editingItem, iconColor: e.target.value })
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Action Type</Label>
                          <Select
                            value={editingItem.itemType}
                            onValueChange={(value) =>
                              setEditingItem({ ...editingItem, itemType: value, actionValue: value === "chat" || value === "navigate" || value === "lead_form" ? "" : editingItem.actionValue })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {itemTypeOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {editingItem.itemType !== "navigate" && editingItem.itemType !== "chat" && editingItem.itemType !== "detail" && editingItem.itemType !== "form" && editingItem.itemType !== "lead_form" && (
                          <div className="space-y-2">
                            <Label>Action Value</Label>
                            <Input
                              value={editingItem.actionValue || ""}
                              onChange={(e) =>
                                setEditingItem({ ...editingItem, actionValue: e.target.value })
                              }
                              placeholder={
                                editingItem.itemType === "url"
                                  ? "https://example.com"
                                  : editingItem.itemType === "phone"
                                  ? "+1234567890"
                                  : ""
                              }
                            />
                          </div>
                        )}
                        {editingItem.itemType === "form" && (
                          <div className="space-y-2">
                            <Label>Journey / Form</Label>
                            <Select
                              value={editingItem.actionValue || ""}
                              onValueChange={(value) =>
                                setEditingItem({ ...editingItem, actionValue: value })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select a journey..." />
                              </SelectTrigger>
                              <SelectContent>
                                {journeys.filter(j => j.status === "active").map((journey) => (
                                  <SelectItem key={journey.id} value={journey.id}>
                                    {journey.name} ({journey.journeyType})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {editingItem.itemType === "detail" && (
                          <DetailsBuilder
                            value={parseDetailsConfig(editingItem.actionValue)}
                            onChange={(config) =>
                              setEditingItem({ ...editingItem, actionValue: stringifyDetailsConfig(config) })
                            }
                          />
                        )}
                        {editingItem.itemType === "lead_form" && (
                          <div className="space-y-3">
                            <Label>Fields to Capture</Label>
                            <div className="space-y-3">
                              {[
                                { key: "name", label: "Name" },
                                { key: "phone", label: "Mobile Number" },
                                { key: "email", label: "Email" },
                              ].map((field) => {
                                const fieldKey = field.key as keyof Omit<LeadFormFieldsConfig, 'custom'>;
                                const fieldsConfig = parseLeadFormFields(editingItem.leadFormFields || undefined);
                                const fieldConfig = fieldsConfig[fieldKey] as LeadFormFieldConfig | undefined;
                                const isVisible = fieldConfig?.visible ?? false;
                                const isRequired = fieldConfig?.required ?? false;
                                
                                return (
                                  <div key={field.key} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                                    <div className="flex items-center gap-3">
                                      <input
                                        type="checkbox"
                                        id={`item-lead-field-${field.key}`}
                                        checked={isVisible}
                                        onChange={(e) => {
                                          const newConfig = { ...fieldsConfig };
                                          if (e.target.checked) {
                                            newConfig[fieldKey] = { visible: true, required: false };
                                          } else {
                                            delete newConfig[fieldKey];
                                          }
                                          const standardKeys = Object.keys(newConfig).filter(k => k !== 'custom');
                                          if (standardKeys.length === 0 && (newConfig.custom || []).length === 0) {
                                            newConfig.name = { visible: true, required: true };
                                          }
                                          setEditingItem({ ...editingItem, leadFormFields: stringifyLeadFormFields(newConfig) });
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                      />
                                      <label htmlFor={`item-lead-field-${field.key}`} className="text-sm text-gray-700">
                                        {field.label}
                                      </label>
                                    </div>
                                    {isVisible && (
                                      <div className="flex items-center gap-2">
                                        <label htmlFor={`item-lead-field-required-${field.key}`} className="text-xs text-gray-500">
                                          Required
                                        </label>
                                        <Switch
                                          id={`item-lead-field-required-${field.key}`}
                                          checked={isRequired}
                                          onCheckedChange={(checked) => {
                                            const newConfig = { ...fieldsConfig };
                                            newConfig[fieldKey] = { visible: true, required: checked };
                                            setEditingItem({ ...editingItem, leadFormFields: stringifyLeadFormFields(newConfig) });
                                          }}
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            <div className="mt-4 space-y-2">
                              <p className="text-sm font-medium text-gray-700">Custom Fields</p>
                              {(parseLeadFormFields(editingItem.leadFormFields || undefined).custom || []).map((field) => (
                                <div key={field.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm text-gray-800 truncate">{field.label}</span>
                                    <span className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded capitalize shrink-0">{field.fieldType}</span>
                                    {field.required && <span className="text-xs text-red-500 shrink-0">Required</span>}
                                  </div>
                                  <div className="flex items-center gap-2 ml-2 shrink-0">
                                    <Switch
                                      checked={field.required}
                                      onCheckedChange={(checked) => {
                                        const fieldsConfig = parseLeadFormFields(editingItem.leadFormFields || undefined);
                                        const newCustom = (fieldsConfig.custom || []).map(f =>
                                          f.id === field.id ? { ...f, required: checked } : f
                                        );
                                        setEditingItem({ ...editingItem, leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                      }}
                                    />
                                    <label className="text-xs text-gray-500">Req.</label>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const fieldsConfig = parseLeadFormFields(editingItem.leadFormFields || undefined);
                                        const newCustom = (fieldsConfig.custom || []).filter(f => f.id !== field.id);
                                        setEditingItem({ ...editingItem, leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                      }}
                                      className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  </div>
                                </div>
                              ))}

                              {showItemAddCustomField ? (
                                <div className="mt-2 p-3 border border-purple-200 rounded-lg bg-purple-50 space-y-3">
                                  <div>
                                    <label className="text-xs font-medium text-gray-700 block mb-1">Field Label</label>
                                    <Input
                                      value={newItemCustomField.label}
                                      onChange={(e) => setNewItemCustomField(prev => ({ ...prev, label: e.target.value }))}
                                      placeholder="e.g. Course you are looking for"
                                      className="text-sm"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-gray-700 block mb-1">Field Type</label>
                                    <Select
                                      value={newItemCustomField.fieldType}
                                      onValueChange={(v) => setNewItemCustomField(prev => ({ ...prev, fieldType: v as 'text' | 'dropdown' | 'textarea' }))}
                                    >
                                      <SelectTrigger className="text-sm">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="text">Text</SelectItem>
                                        <SelectItem value="dropdown">Dropdown</SelectItem>
                                        <SelectItem value="textarea">Textarea</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  {newItemCustomField.fieldType === 'dropdown' && (
                                    <div>
                                      <label className="text-xs font-medium text-gray-700 block mb-1">Options (one per line)</label>
                                      <Textarea
                                        value={newItemCustomField.options}
                                        onChange={(e) => setNewItemCustomField(prev => ({ ...prev, options: e.target.value }))}
                                        placeholder={"MBA\nBCA\nMCA\nBBA"}
                                        rows={4}
                                        className="text-sm"
                                      />
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2">
                                    <Switch
                                      checked={newItemCustomField.required}
                                      onCheckedChange={(checked) => setNewItemCustomField(prev => ({ ...prev, required: checked }))}
                                    />
                                    <label className="text-xs text-gray-600">Required</label>
                                  </div>
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      onClick={() => {
                                        if (!newItemCustomField.label.trim()) return;
                                        const fieldsConfig = parseLeadFormFields(editingItem.leadFormFields || undefined);
                                        const options = newItemCustomField.fieldType === 'dropdown'
                                          ? newItemCustomField.options.split('\n').map(o => o.trim()).filter(Boolean)
                                          : [];
                                        const newField: CustomLeadField = {
                                          id: crypto.randomUUID(),
                                          label: newItemCustomField.label.trim(),
                                          fieldType: newItemCustomField.fieldType,
                                          options,
                                          required: newItemCustomField.required,
                                        };
                                        const newCustom = [...(fieldsConfig.custom || []), newField];
                                        setEditingItem({ ...editingItem, leadFormFields: stringifyLeadFormFields({ ...fieldsConfig, custom: newCustom }) });
                                        setShowItemAddCustomField(false);
                                        setNewItemCustomField({ label: '', fieldType: 'text', options: '', required: false });
                                      }}
                                      className="text-xs"
                                    >
                                      Save Field
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setShowItemAddCustomField(false);
                                        setNewItemCustomField({ label: '', fieldType: 'text', options: '', required: false });
                                      }}
                                      className="text-xs"
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setShowItemAddCustomField(true)}
                                  className="flex items-center gap-1.5 text-sm text-purple-600 hover:text-purple-800 font-medium mt-1"
                                >
                                  <Plus className="w-4 h-4" />
                                  Add Custom Field
                                </button>
                              )}
                            </div>

                            <p className="text-xs text-muted-foreground mt-2">
                              Configure which fields this lead form captures. Custom fields are saved as Topics of Interest.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setEditingItem(null)}>
                        Cancel
                      </Button>
                      <Button 
                        onClick={() => {
                          if (editingItem) {
                            updateItemMutation.mutate({
                              id: editingItem.id,
                              title: editingItem.title,
                              subtitle: editingItem.subtitle,
                              icon: editingItem.icon,
                              iconBgColor: editingItem.iconBgColor,
                              iconColor: editingItem.iconColor,
                              itemType: editingItem.itemType,
                              actionValue: editingItem.actionValue,
                              leadFormFields: editingItem.itemType === 'lead_form' ? editingItem.leadFormFields : null,
                            });
                          }
                        }} 
                        disabled={!editingItem?.title}
                      >
                        Save Changes
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {rootItems.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Folder className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No menu items yet</p>
                  <p className="text-sm">Click "Add Item" to create your first menu item</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {rootItems
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((item) => (
                      <div key={item.id}>
                        <div className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/50">
                          <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab" />
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: item.iconBgColor }}
                          >
                            {(() => { const Icon = getMenuBuilderIcon(item.icon); return <Icon className="w-5 h-5" style={{ color: item.iconColor }} />; })()}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium">{item.title}</div>
                            {item.subtitle && (
                              <div className="text-sm text-muted-foreground">
                                {item.subtitle}
                              </div>
                            )}
                          </div>
                          <span className="text-xs bg-muted px-2 py-1 rounded">
                            {itemTypeOptions.find((o) => o.value === item.itemType)?.label}
                          </span>
                          {item.itemType === "navigate" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedParentId(item.id);
                                setIsAddDialogOpen(true);
                              }}
                            >
                              <Plus className="w-4 h-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingItem(item)}
                          >
                            <Pencil className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteItemMutation.mutate(item.id)}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </div>
                        {item.itemType === "navigate" && getChildren(item.id).length > 0 && (
                          <div className="ml-8 mt-2 space-y-2">
                            {getChildren(item.id)
                              .sort((a, b) => a.sortOrder - b.sortOrder)
                              .map((child) => (
                                <div
                                  key={child.id}
                                  className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/50"
                                >
                                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                  <div
                                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                                    style={{ backgroundColor: child.iconBgColor }}
                                  >
                                    {(() => { const Icon = getMenuBuilderIcon(child.icon); return <Icon className="w-4 h-4" style={{ color: child.iconColor }} />; })()}
                                  </div>
                                  <div className="flex-1">
                                    <div className="font-medium text-sm">{child.title}</div>
                                    {child.subtitle && (
                                      <div className="text-xs text-muted-foreground">
                                        {child.subtitle}
                                      </div>
                                    )}
                                  </div>
                                  <span className="text-xs bg-muted px-2 py-1 rounded">
                                    {
                                      itemTypeOptions.find((o) => o.value === child.itemType)
                                        ?.label
                                    }
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingItem(child)}
                                  >
                                    <Pencil className="w-4 h-4 text-muted-foreground" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteItemMutation.mutate(child.id)}
                                  >
                                    <Trash2 className="w-4 h-4 text-destructive" />
                                  </Button>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        )}

      </Tabs>
    </div>
    </div>
  );
}
