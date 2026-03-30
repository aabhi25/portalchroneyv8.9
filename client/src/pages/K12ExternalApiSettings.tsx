import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Database, Loader2, CheckCircle2, XCircle, Eye, EyeOff, Globe, Key, Zap } from "lucide-react";

interface ExternalApiConfig {
  apiBaseUrl: string;
  apiToken: string;
  configured: boolean;
}

export default function K12ExternalApiSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState("");

  const { data: config, isLoading } = useQuery<ExternalApiConfig>({
    queryKey: ['/api/k12/external-api-config'],
    queryFn: async () => {
      const response = await fetch('/api/k12/external-api-config', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch config');
      return response.json();
    }
  });

  useEffect(() => {
    if (config) {
      setApiBaseUrl(config.apiBaseUrl || '');
      setApiToken(config.apiToken || '');
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async (data: { apiBaseUrl: string; apiToken: string }) => {
      const response = await fetch('/api/k12/external-api-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error('Failed to save');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/k12/external-api-config'] });
      toast({ title: "Settings saved", description: "External API configuration has been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
    }
  });

  const handleSave = () => {
    saveMutation.mutate({ apiBaseUrl, apiToken });
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const response = await fetch('/api/k12/external-api-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ apiBaseUrl, apiToken }),
      });
      const result = await response.json();
      setTestStatus(result.success ? 'success' : 'error');
      setTestMessage(result.message);
    } catch {
      setTestStatus('error');
      setTestMessage('Failed to test connection');
    }
  };

  const handleDisconnect = () => {
    setApiBaseUrl('');
    setApiToken('');
    saveMutation.mutate({ apiBaseUrl: '', apiToken: '' });
    setTestStatus('idle');
    setTestMessage('');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg">
          <Database className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">External Content API</h1>
          <p className="text-sm text-gray-500">Connect your content management system to power the AI tutor</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-600" />
            API Connection
          </CardTitle>
          <CardDescription>
            Configure your external content API so the AI tutor can fetch topics, revision notes, videos, and practice questions directly from your system.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="apiBaseUrl" className="text-sm font-medium">API Base URL</Label>
            <div className="relative">
              <Globe className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                id="apiBaseUrl"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://api.yourplatform.com"
                className="pl-10"
              />
            </div>
            <p className="text-xs text-gray-400">The base URL of your content management API</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiToken" className="text-sm font-medium">API Token</Label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                id="apiToken"
                type={showToken ? "text" : "password"}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Enter your API token"
                className="pl-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-gray-400">Authentication token for API access (Bearer token)</p>
          </div>

          {testStatus !== 'idle' && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
              testStatus === 'testing' ? 'bg-blue-50 text-blue-700' :
              testStatus === 'success' ? 'bg-green-50 text-green-700' :
              'bg-red-50 text-red-700'
            }`}>
              {testStatus === 'testing' && <Loader2 className="w-4 h-4 animate-spin" />}
              {testStatus === 'success' && <CheckCircle2 className="w-4 h-4" />}
              {testStatus === 'error' && <XCircle className="w-4 h-4" />}
              <span>{testStatus === 'testing' ? 'Testing connection...' : testMessage}</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              onClick={handleTestConnection}
              variant="outline"
              disabled={!apiBaseUrl || !apiToken || testStatus === 'testing'}
              className="gap-2"
            >
              <Zap className="w-4 h-4" />
              Test Connection
            </Button>
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
            >
              {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Settings
            </Button>
            {config?.configured && (
              <Button
                onClick={handleDisconnect}
                variant="ghost"
                className="text-red-600 hover:text-red-700 hover:bg-red-50 ml-auto"
              >
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-blue-100 bg-blue-50/30">
        <CardContent className="pt-6">
          <h3 className="font-semibold text-sm text-blue-900 mb-2">How it works</h3>
          <ul className="space-y-2 text-sm text-blue-800/80">
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600 mt-0.5">1.</span>
              Enter your content API URL and authentication token above
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600 mt-0.5">2.</span>
              Test the connection to verify the API is accessible
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600 mt-0.5">3.</span>
              Once connected, the AI tutor will automatically fetch topics, notes, videos, and questions from your system
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-blue-600 mt-0.5">4.</span>
              Your content stays in your system — no duplication needed
            </li>
          </ul>
        </CardContent>
      </Card>

      {config?.configured && (
        <Card className="border-green-100 bg-green-50/30">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <h3 className="font-semibold text-sm text-green-900">Connected</h3>
            </div>
            <p className="text-sm text-green-800/70">
              External content API is active. The AI tutor is fetching content from your system in real-time when students ask questions.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
