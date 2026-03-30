(function() {
  var currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  
  var businessAccountId = currentScript.getAttribute('data-business-id');
  if (!businessAccountId) {
    console.error('[Chroney Widget] Missing data-business-id attribute');
    return;
  }
  
  var apiBase = currentScript.src.replace(/\/widget-loader\.js.*$/, '');
  var config = { businessAccountId: businessAccountId };
  
  var VISITOR_KEY = 'chroney_visitor_' + config.businessAccountId;
  var visitorToken = localStorage.getItem(VISITOR_KEY);
  if (!visitorToken) {
    visitorToken = 'v_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem(VISITOR_KEY, visitorToken);
  }
  
  var sessionId = 's_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  var currentPageViewId = null;
  var pageStartTime = Date.now();
  var maxScrollDepth = 0;
  var sectionData = {};
  
  function trackPageVisitor() {
    var deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 
                     /Tablet|iPad/i.test(navigator.userAgent) ? 'tablet' : 'desktop';
    var browserMatch = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge|Opera)/i);
    var browser = browserMatch ? browserMatch[1] : 'Unknown';
    var osMatch = navigator.userAgent.match(/(Windows|Mac|Linux|Android|iOS)/i);
    var os = osMatch ? osMatch[1] : 'Unknown';
    
    fetch(apiBase + '/api/widget/page-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessAccountId: config.businessAccountId,
        visitorToken: visitorToken,
        deviceType: deviceType,
        browser: browser,
        os: os,
        userAgent: navigator.userAgent
      })
    }).catch(function() {});
  }
  
  function trackPageView() {
    var pagePath = window.location.pathname;
    var referrerUrl = document.referrer || null;
    
    fetch(apiBase + '/api/widget/page-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessAccountId: config.businessAccountId,
        visitorToken: visitorToken,
        pageUrl: window.location.href,
        pageTitle: document.title,
        pagePath: pagePath,
        sessionId: sessionId,
        referrerUrl: referrerUrl
      })
    }).then(function(r) { return r.json(); })
      .then(function(data) { currentPageViewId = data.pageViewId; })
      .catch(function() {});
  }
  
  function updateScrollDepth() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    var winHeight = window.innerHeight;
    var scrollPercent = Math.round((scrollTop / (docHeight - winHeight)) * 100);
    maxScrollDepth = Math.max(maxScrollDepth, Math.min(scrollPercent, 100));
  }
  
  function setupSectionTracking() {
    if (!('IntersectionObserver' in window)) return;
    
    var sections = document.querySelectorAll('section, article, [data-section], header, main, footer, .section');
    if (sections.length === 0) {
      var headings = document.querySelectorAll('h1, h2, h3');
      headings.forEach(function(h, i) {
        var parent = h.parentElement;
        if (parent && !parent.hasAttribute('data-chroney-section')) {
          parent.setAttribute('data-chroney-section', i);
        }
      });
      sections = document.querySelectorAll('[data-chroney-section]');
    }
    
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        var el = entry.target;
        var sectionId = el.id || el.getAttribute('data-section') || el.getAttribute('data-chroney-section') || ('section-' + Array.from(el.parentElement.children).indexOf(el));
        var sectionName = el.getAttribute('aria-label') || (el.querySelector('h1, h2, h3') ? el.querySelector('h1, h2, h3').textContent.substring(0, 50) : sectionId);
        var sectionType = el.tagName.toLowerCase();
        
        if (!sectionData[sectionId]) {
          sectionData[sectionId] = { name: sectionName, type: sectionType, time: 0, visible: false, lastStart: null, index: Object.keys(sectionData).length };
        }
        
        if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
          if (!sectionData[sectionId].visible) {
            sectionData[sectionId].visible = true;
            sectionData[sectionId].lastStart = Date.now();
          }
        } else {
          if (sectionData[sectionId].visible && sectionData[sectionId].lastStart) {
            sectionData[sectionId].time += (Date.now() - sectionData[sectionId].lastStart) / 1000;
            sectionData[sectionId].visible = false;
          }
        }
      });
    }, { threshold: [0, 0.3, 0.5, 1] });
    
    sections.forEach(function(s) { observer.observe(s); });
  }
  
  function sendEngagementData() {
    if (!currentPageViewId) return;
    
    Object.keys(sectionData).forEach(function(id) {
      var s = sectionData[id];
      if (s.visible && s.lastStart) {
        s.time += (Date.now() - s.lastStart) / 1000;
      }
    });
    
    var timeSpent = Math.round((Date.now() - pageStartTime) / 1000);
    updateScrollDepth();
    
    navigator.sendBeacon(apiBase + '/api/widget/page-view/' + currentPageViewId, JSON.stringify({
      timeSpentSeconds: timeSpent,
      scrollDepthPercent: maxScrollDepth
    }));
    
    var sectionsArray = Object.keys(sectionData).map(function(id) {
      var s = sectionData[id];
      return { sectionId: id, sectionName: s.name, sectionType: s.type, sectionIndex: s.index, timeSpentSeconds: Math.round(s.time) };
    }).filter(function(s) { return s.timeSpentSeconds > 0; });
    
    if (sectionsArray.length > 0) {
      navigator.sendBeacon(apiBase + '/api/widget/sections-batch', JSON.stringify({
        businessAccountId: config.businessAccountId,
        pageViewId: currentPageViewId,
        visitorToken: visitorToken,
        sections: sectionsArray
      }));
    }
  }
  
  trackPageVisitor();
  trackPageView();
  setTimeout(setupSectionTracking, 1000);
  window.addEventListener('scroll', updateScrollDepth, { passive: true });
  window.addEventListener('beforeunload', sendEngagementData);
  window.addEventListener('pagehide', sendEngagementData);
  
  var pushState = history.pushState;
  history.pushState = function() {
    sendEngagementData();
    pushState.apply(history, arguments);
    setTimeout(function() {
      pageStartTime = Date.now();
      maxScrollDepth = 0;
      sectionData = {};
      currentPageViewId = null;
      trackPageView();
      setupSectionTracking();
    }, 100);
  };
  
  function checkProactiveGuidanceAndInit() {
    var currentUrl = window.location.pathname + window.location.search;
    
    fetch(apiBase + '/api/public/proactive-guidance-rules/' + encodeURIComponent(config.businessAccountId))
      .then(function(r) { return r.json(); })
      .then(function(rules) {
        var hasMatchingRule = false;
        
        if (rules && rules.length > 0) {
          for (var i = 0; i < rules.length; i++) {
            var rule = rules[i];
            var pattern = rule.urlPattern;
            
            if (pattern === currentUrl) {
              hasMatchingRule = true;
              break;
            }
            
            if (pattern.includes('*')) {
              var escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
              var regexPattern = escaped.replace(/\*/g, '.*');
              try {
                var regex = new RegExp('^' + regexPattern + '$');
                if (regex.test(currentUrl)) {
                  hasMatchingRule = true;
                  break;
                }
              } catch (e) {}
            }
            
            if (currentUrl.indexOf(pattern) === 0) {
              hasMatchingRule = true;
              break;
            }
          }
        }
        
        if (hasMatchingRule) {
          console.log('[Chroney Widget] Proactive guidance active - auto-opening chat');
          config.autoOpenChat = 'both';
          config.autoOpenFrequency = 'always';
          config.proactiveGuidanceActive = true;
        }
        
        initWidget();
      })
      .catch(function(err) {
        console.log('[Chroney Widget] Could not check proactive guidance:', err);
        initWidget();
      });
  }
  
  function initWidget() {
    var script = document.createElement('script');
    script.src = apiBase + '/widget.js';
    script.onload = function() {
      if (window.HiChroneyWidget) {
        window.HiChroneyWidget.init(config);
      }
    };
    document.body.appendChild(script);
  }
  
  checkProactiveGuidanceAndInit();
})();
