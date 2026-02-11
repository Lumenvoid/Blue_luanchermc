async function startAuth() {
  document.getElementById('authStatus').innerHTML = '<div class="loading-spinner"></div> Waiting for Microsoft login...';
  
  const result = await window.electronAPI.startMicrosoftAuth();
  
  if (result.success) {
    authState.isAuthenticated = true;
    authState.user = result.user;
    authState.tokens = result.tokens;
    
    localStorage.setItem('blue_launcher_auth', JSON.stringify({
      user: result.user,
      tokens: result.tokens,
      timestamp: Date.now()
    }));
    
    updateUI();
    cancelAuth();
    showToast(`Welcome, ${result.user.name}!`, 'success');
  } else {
    showToast('Auth failed: ' + result.error, 'error');
  }
}
