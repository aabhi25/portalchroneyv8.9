import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, ArrowLeft, CheckCircle2 } from "lucide-react";
import { useLocation } from "wouter";
import MoreFeaturesNavTabs from "@/components/MoreFeaturesNavTabs";

export default function CRMIntegrations() {
  const [, setLocation] = useLocation();

  const crmIntegrations = [
    {
      id: "leadsquared",
      name: "LeadSquared",
      description: "Automatically sync captured leads to your LeadSquared CRM account",
      features: [
        "Real-time lead sync",
        "Multi-region support (India, US, Custom)",
        "Secure credential storage",
        "Sync status tracking",
      ],
      available: true,
      route: "/admin/leadsquared",
    },
    {
      id: "salesforce",
      name: "Salesforce",
      description: "Sync captured leads to Salesforce CRM using the REST API",
      features: [
        "OAuth2 authentication",
        "Real-time lead sync",
        "Custom field mappings",
        "Production & Sandbox support",
      ],
      available: true,
      route: "/admin/salesforce",
    },
    {
      id: "custom-crm",
      name: "Custom CRM",
      description: "Connect to any in-house CRM with configurable API endpoints, authentication, and field mappings",
      features: [
        "Any REST API endpoint",
        "Multiple auth methods (API Key, Bearer, HMAC Checksum)",
        "Custom field mappings",
        "Form-data & JSON support",
      ],
      available: true,
      route: "/admin/custom-crm",
    },
  ];

  return (
    <div>
      <MoreFeaturesNavTabs />
      <div className="container mx-auto p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">CRM Integrations</h1>
        <p className="text-muted-foreground">
          Connect your favorite CRM to automatically sync leads captured by Chroney
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {crmIntegrations.map((crm) => (
          <Card key={crm.id} className="relative overflow-hidden">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-xl">{crm.name}</CardTitle>
                  <CardDescription className="mt-2">
                    {crm.description}
                  </CardDescription>
                </div>
                {crm.available && (
                  <div className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-950 dark:text-green-400 px-2 py-1 rounded-full">
                    <CheckCircle2 className="h-3 w-3" />
                    Available
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {crm.features.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Features:</p>
                    <ul className="space-y-1.5">
                      {crm.features.map((feature, index) => (
                        <li key={index} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button
                  onClick={() => setLocation(crm.route)}
                  disabled={!crm.available}
                  className={crm.available ? "w-full bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600" : "w-full"}
                  variant={crm.available ? "default" : "outline"}
                >
                  {crm.available ? (
                    <>
                      Configure Integration
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  ) : (
                    "Coming Soon"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
    </div>
  );
}
