(function() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

function handleSubmit(e) {
  e.preventDefault();
  
  const password = document.getElementById('passwordInput').value;
  const errorMessage = document.getElementById('errorMessage');
  
  if (!password) {
    errorMessage.textContent = '请输入密码';
    errorMessage.classList.add('show');
    return false;
  }
  
  sessionStorage.setItem('sitePassword', password);
  
  const currentPath = window.location.pathname + window.location.search;
  
  fetch(currentPath, {
    headers: {
      'X-Site-Password': password
    }
  })
  .then(response => {
    if (response.ok) {
      window.location.reload();
    } else {
      errorMessage.textContent = '密码错误，请重试';
      errorMessage.classList.add('show');
      document.getElementById('passwordInput').value = '';
      document.getElementById('passwordInput').focus();
    }
  })
  .catch(() => {
    errorMessage.textContent = '网络错误，请重试';
    errorMessage.classList.add('show');
  });
  
  return false;
}

(function() {
  const savedPassword = sessionStorage.getItem('sitePassword');
  if (savedPassword) {
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
      options.headers = options.headers || {};
      options.headers['X-Site-Password'] = savedPassword;
      return originalFetch(url, options);
    };
  }
})();
