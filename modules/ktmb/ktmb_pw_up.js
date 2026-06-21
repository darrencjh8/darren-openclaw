const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('request', req => {
    if (req.url().includes('UpdatePassenger') && req.method() === 'POST') {
      console.log('\n=== UpdatePassenger POST ===');
      for (const [k,v] of Object.entries(req.headers())) {
        console.log('  Header:', k + ':', v.substring(0,200));
      }
      const body = req.postData();
      console.log('  Body (' + body.length + ' chars):');
      console.log(body);
    }
  });
  page.on('response', res => {
    if (res.url().includes('UpdatePassenger') && res.request().method() === 'POST') {
      console.log('\n=== UpdatePassenger RESPONSE ===');
      console.log('  Status:', res.status());
      console.log('  Location:', res.headers()['location']||'N/A');
    }
  });
  
  // LOGIN
  console.log('=== LOGIN ===');
  await page.goto('https://online.ktmb.com.my/Account/Login', { waitUntil: 'networkidle' });
  await page.fill('input[name="Email"]', process.env.KTMB_EMAIL || '');
  await page.fill('input[name="Password"]', process.env.KTMB_PASSWORD || '');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  console.log('Login URL:', page.url().substring(0,50));
  if (page.url().includes('Login')) {
    const errs = await page.evaluate(() => 
      Array.from(document.querySelectorAll('.validation-summary-errors,.field-validation-error')).map(e=>e.textContent.trim()));
    console.log('Failed:', errs);
    await browser.close(); return;
  }
  
  // SEARCH
  console.log('\n=== SEARCH ===');
  await page.goto('https://shuttleonline.ktmb.com.my/Home/Shuttle', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.getElementById('FromStationId').value = 'JB SENTRAL';
    document.getElementById('ToStationId').value = 'WOODLANDS CIQ';
    document.getElementById('OnwardDate').value = '07/06/2026';
    document.getElementById('PassengerCount').value = '1';
    document.getElementById('theForm').submit();
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  console.log('Search URL:', page.url().substring(0,60));
  
  // CLICK FIRST SEAT
  const seatBtns = await page.locator('.btn-seat-layout').count();
  console.log('Seat buttons:', seatBtns);
  if (seatBtns === 0) { console.log('No seats'); await browser.close(); return; }
  
  await page.locator('.btn-seat-layout').first().click();
  await page.waitForTimeout(3000);
  
  // Handle reCAPTCHA
  const recapFrame = await page.locator('iframe[title="reCAPTCHA"]').count();
  console.log('reCAPTCHA shown:', recapFrame > 0);
  
  if (recapFrame > 0) {
    const frame = page.frameLocator('iframe[title="reCAPTCHA"]');
    try {
      await frame.locator('.recaptcha-checkbox-border').click();
      console.log('Clicked reCAPTCHA checkbox');
      await page.waitForTimeout(5000);
      const gotToken = await page.evaluate('grecaptcha.getResponse()');
      console.log('reCAPTCHA solved?', gotToken ? 'YES' : 'NO');
    } catch(e) {
      console.log('reCAPTCHA click failed:', e.message.substring(0,80));
    }
  }
  
  // Wait for reserve + passenger page
  await page.waitForTimeout(8000);
  console.log('\nAfter reserve/passenger:', page.url().substring(0,60));
  
  const fullName = await page.locator('[name="Passengers[0].FullName"]').count();
  console.log('On passenger page?', fullName > 0);
  
  if (fullName > 0) {
    // Fill form
    await page.fill('[name="Passengers[0].FullName"]', process.env.KTMB_PAX_NAME || '');
    await page.fill('[name="Passengers[0].PassportNo"]', process.env.KTMB_PAX_PASSPORT || '');
    await page.fill('[name="Passengers[0].PassportExpiryDate"]', process.env.KTMB_PAX_EXPIRY || '');
    await page.fill('[name="Passengers[0].ContactNo"]', process.env.KTMB_PAX_CONTACT || '');
    
    // Extract the JS-built data
    console.log('\n=== JS-build data ===');
    const jsData = await page.evaluate(() => {
      let data = {};
      data.BookingData = document.querySelector('[name="BookingData"]').value;
      var passengerArray = [];
      var currentPassenger = document.querySelector('.passenger-section');
      var passenger = {};
      passenger.FullName = currentPassenger.querySelector('.FullName').value;
      passenger.TicketTypeId = currentPassenger.querySelector('.TicketTypeId').value;
      if (currentPassenger.querySelector('.ContactNo').value.length > 0)
          passenger.ContactNo = currentPassenger.querySelector('.ContactNo').value;
      if (currentPassenger.querySelector('.PassportNo').value.length > 0)
          passenger.PassportNo = currentPassenger.querySelector('.PassportNo').value;
      if (currentPassenger.querySelector('.PassportExpiryDate').value.length > 0) {
          var d = new Date(currentPassenger.querySelector('.PassportExpiryDate').value);
          passenger.PassportExpiryDate = d.toISOString().substring(0,10);
      }
      var genderEl = currentPassenger.querySelector('.Gender:checked');
      passenger.Gender = genderEl ? genderEl.value : 'M';
      var isSelfEl = currentPassenger.querySelector('.IsSelf');
      passenger.IsSelf = isSelfEl ? isSelfEl.checked : false;
      var isFavEl = currentPassenger.querySelector('.IsAddFavorite');
      passenger.IsAddFavorite = isFavEl ? isFavEl.checked : false;
      passenger.IsBuyInsurance = false;
      passenger.PassengerData = currentPassenger.querySelector('.PassengerData').value;
      passenger.PassengerPNRData = '';
      passenger.Tickets = [];
      passengerArray.push(passenger);
      data.Passengers = passengerArray;
      return data;
    });
    console.log(JSON.stringify(jsData, null, 2));
    
    // Click PROCEED TO PAYMENT
    console.log('\n=== CLICKING PROCEED TO PAYMENT ===');
    await page.click('#btnConfirmPayment');
    await page.waitForTimeout(5000);
    console.log('After payment click:', page.url().substring(0,80));
  }
  
  await browser.close();
  console.log('\nDone');
})();
