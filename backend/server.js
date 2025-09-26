// server.js - FINAL DEPLOYMENT VERSION

// 1. Import necessary packages
const express = require('express');
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const cron = require('node-cron');
const ExcelJS = require('exceljs');
require('dotenv').config();

// 2. Initialize Express, Cloudinary, and SendGrid
const app = express();
const PORT = process.env.PORT || 5000;

cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET 
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

let fileQueue = [];

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected successfully.'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Mongoose Schema (defines the data structure) ---
const registrationSchema = new mongoose.Schema({
    serialNumber: { type: String, unique: true },
    admission_no: String, sdmis_ref_no: String, courseName: String,
    department: String, duration: String, applicantName: String,
    dob: String, gender: String, fatherName: String, motherName: String,
    address: String, email: String, mobile: String, aadhar: String,
    fromDate: String, toDate: String, casteCategory: String, course_fees: String,
    education: [{ course: String, school: String, spec: String, year: String, perc: String }],
    certificateUrl: String,
    applicationFormUrl: String,
    submissionDate: { type: Date, default: Date.now }
});

const Registration = mongoose.model('Registration', registrationSchema);

// 3. Middleware Setup
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// IMPORTANT: Correctly serve static files from the 'frontend' directory
// This assumes your Dockerfile copies the 'frontend' folder to the root of the app directory
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Define paths
const outputDir = path.join(__dirname, '..', 'output');
const certificateDir = path.join(__dirname, '..', 'frontend', 'certificate');
const certificateTemplatePath = path.join(certificateDir, 'certificate.html');
const certificateCssPath = path.join(certificateDir, 'certificate.css');
const applicationFormDir = path.join(__dirname, '..', 'frontend', 'application_form');
const applicationFormTemplatePath = path.join(applicationFormDir, 'index.html');
const applicationFormCssPath = path.join(applicationFormDir, 'style.css');
const serialNumberFilePath = path.join(__dirname, 'serial_number.txt');

fs.mkdir(outputDir, { recursive: true });

// --- HELPER FUNCTIONS ---

async function getNextSerialNumber() {
  // Find the single registration with the highest serial number
  const lastRegistration = await Registration.findOne().sort({ serialNumber: -1 });

  let nextNumber = 819; // A default starting number if the database is empty

  if (lastRegistration && lastRegistration.serialNumber) {
    const lastNumber = parseInt(lastRegistration.serialNumber, 10);
    nextNumber = lastNumber + 1;
  }

  return nextNumber.toString().padStart(6, '0');
}

async function uploadToCloudinary(filePath, studentName) {
    try {
        // This is the fix: path.parse(filePath).name gets the filename WITHOUT the extension
        const fileNameWithoutExt = path.parse(filePath).name;

        const result = await cloudinary.uploader.upload(filePath, {
            resource_type: 'image',
            public_id: `citd-forms/${studentName}_${fileNameWithoutExt}`, // Use the name without extension
            upload_preset: 'ip8faemc' // Make sure this is your actual preset name
        });

        console.log(`✅ Uploaded to Cloudinary: ${result.secure_url}`);
        return result.secure_url;
    } catch (error) {
        console.error('❌ Cloudinary Upload Error:', error);
        return null;
    }
}

async function generateCertificate(data) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    let htmlTemplate = await fs.readFile(certificateTemplatePath, 'utf8');
    const cssContent = await fs.readFile(certificateCssPath, 'utf8');
    const msmeLogoPath = path.join(certificateDir, 'msme.png');
    const citdLogoPath = path.join(certificateDir, 'citd main.png');
    const msmeLogoBase64 = await fs.readFile(msmeLogoPath, 'base64');
    const citdLogoBase64 = await fs.readFile(citdLogoPath, 'base64');
    const msmeDataUrl = `data:image/png;base64,${msmeLogoBase64}`;
    const citdDataUrl = `data:image/png;base64,${citdLogoBase64}`;
    htmlTemplate = htmlTemplate
        .replace('src="msme.png"', `src="${msmeDataUrl}"`)
        .replace('src="citd main.png"', `src="${citdDataUrl}"`);
    const finalHtml = htmlTemplate.replace('</head>', `<style>${cssContent}</style></head>`);
    
    // CORRECTED: Use 'domcontentloaded' to prevent timeouts
    await page.setContent(finalHtml, { waitUntil: 'domcontentloaded' });

    await page.evaluate(data => {
        const formatDate = (dateString) => {
            if (!dateString || typeof dateString !== 'string') return '';
            const parts = dateString.split('-');
            if (parts.length !== 3) return dateString;
            const [year, month, day] = parts;
            return `${day}-${month}-${year}`;
        };
        let mainText = '';
        if (data.gender === 'Mr.') {
            mainText = `This is to certify that <strong>${data.gender} ${data.applicantName.toUpperCase()}</strong> S/o <strong>${data.fatherName.toUpperCase()}</strong> is awarded this certificate in recognition`;
        } else if (data.gender === 'Ms.') {
            mainText = `This is to certify that <strong>${data.gender} ${data.applicantName.toUpperCase()}</strong> D/o <strong>${data.fatherName.toUpperCase()}</strong> is awarded this certificate in recognition`;
        } else {
            mainText = `This is to certify that <strong>${data.applicantName.toUpperCase()}</strong> S/o / D/o <strong>${data.fatherName.toUpperCase()}</strong> is awarded this certificate in recognition`;
        }
        document.getElementById('cert-main-text').innerHTML = mainText;
        document.getElementById('cert-serial').textContent = data.serialNumber;
        document.getElementById('cert-course').textContent = `INTERNSHIP PROGRAMME ON ${data.courseName.toUpperCase()}`;
        document.getElementById('cert-start').textContent = formatDate(data.fromDate);
        document.getElementById('cert-end').textContent = formatDate(data.toDate);
        document.getElementById('cert-issue-date').textContent = formatDate(data.toDate);
        if (data.photo) {
            const photoElem = document.getElementById('cert-photo');
            if (photoElem) { photoElem.src = data.photo; }
        }
    }, data);

    const pdfFileName = `Certificate-${data.applicantName.replace(/\s+/g, '_')}-${Date.now()}.pdf`;
    const pdfPath = path.join(outputDir, pdfFileName);
    await page.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true });
    await browser.close();
    console.log(`✅ PDF certificate generated locally: ${pdfPath}`);
    return { path: pdfPath, url: await uploadToCloudinary(pdfPath, data.applicantName) };
}

async function generateApplicationFormPdf(data) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    let htmlTemplate = await fs.readFile(applicationFormTemplatePath, 'utf8');
    const cssContent = await fs.readFile(applicationFormCssPath, 'utf8');
    const msmeLogoPath = path.join(applicationFormDir, 'msme.png');
    const citdLogoPath = path.join(applicationFormDir, 'citd main.png');
    const msmeLogoBase64 = await fs.readFile(msmeLogoPath, 'base64');
    const citdLogoBase64 = await fs.readFile(citdLogoPath, 'base64');
    const msmeDataUrl = `data:image/png;base64,${msmeLogoBase64}`;
    const citdDataUrl = `data:image/png;base64,${citdLogoBase64}`;
    htmlTemplate = htmlTemplate
        .replace('src="msme.png"', `src="${msmeDataUrl}"`)
        .replace('src="citd main.png"', `src="${citdDataUrl}"`);
    const finalHtml = htmlTemplate.replace('</head>', `<style>${cssContent}</style></head>`);
    
    // CORRECTED: Use 'domcontentloaded' to prevent timeouts
    await page.setContent(finalHtml, { waitUntil: 'domcontentloaded' });

    await page.evaluate(data => {
        document.getElementById('course-name').value = data.courseName || '';
        document.getElementById('department').value = data.department || '';
        document.getElementById('duration').value = data.duration || '';
        document.getElementById('from-date').value = data.fromDate || '';
        document.getElementById('to-date').value = data.toDate || '';
        document.getElementById('applicant-name').value = data.applicantName || '';
        document.getElementById('dob').value = data.dob || '';
        document.getElementById('father-name').value = data.fatherName || '';
        document.getElementById('mother-name').value = data.motherName || '';
        document.getElementById('address').value = data.address || '';
        document.getElementById('mobile').value = data.mobile || '';
        document.getElementById('email').value = data.email || '';
        document.getElementById('aadhar').value = data.aadhar || '';
        document.getElementById('course_fees').value = data.course_fees || '';
        if (data.casteCategory) {
            const radio = document.querySelector(`input[name="caste"][value="${data.casteCategory}"]`);
            if (radio) radio.checked = true;
        }
        if (data.education && data.education.length > 0) {
            document.querySelector('[name="edu_course"]').value = data.education[0].course || '';
            document.querySelector('[name="edu_school"]').value = data.education[0].school || '';
            document.querySelector('[name="edu_spec"]').value = data.education[0].spec || '';
            document.querySelector('[name="edu_year"]').value = data.education[0].year || '';
            document.querySelector('[name="edu_perc"]').value = data.education[0].perc || '';
        }
        if (data.gender === 'Mr.') {
            document.getElementById('gender_male').checked = true;
        } else if (data.gender === 'Ms.') {
            document.getElementById('gender_female').checked = true;
        }
        if (data.photo) {
            const photoElem = document.getElementById('preview');
            if (photoElem) {
                photoElem.src = data.photo;
                photoElem.style.display = 'block';
            }
        }
        const submitBtn = document.querySelector('.submit-btn');
        if(submitBtn) submitBtn.style.display = 'none';
    }, data);
    
    const pdfFileName = `Application-${data.applicantName.replace(/\s+/g, '_')}-${Date.now()}.pdf`;
    const pdfPath = path.join(outputDir, pdfFileName);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    await browser.close();
    console.log(`✅ PDF application form generated locally: ${pdfPath}`);
    return { path: pdfPath, url: await uploadToCloudinary(pdfPath, data.applicantName) };
}

// --- EMAIL FUNCTIONS (Updated for SendGrid) ---
async function sendStudentEmail(data, applicationFormPath) {
    try {
        const attachmentContent = await fs.readFile(applicationFormPath);
        const mailOptions = {
            from: {
                name: "CITD Hyderabad",
                email: process.env.SENDER_EMAIL
            },
            to: data.email,
            subject: 'Application Received - CITD Short Term Course',
            html: `<h3>Dear ${data.applicantName},</h3><p>Thank you for registering... a copy of your form is attached.</p>`,
            attachments: [{
                content: attachmentContent.toString('base64'),
                filename: path.basename(applicationFormPath),
                type: 'application/pdf',
                disposition: 'attachment',
            }],
        };
        await sgMail.send(mailOptions);
        console.log(`✅ Confirmation email sent to student: ${data.email}`);
    } catch (error) {
        console.error(`❌ Failed to send email to student: ${data.email}`, error);
        if (error.response) { console.error(error.response.body); }
    }
}

async function sendBatchedFacultyEmail() {
    if (fileQueue.length === 0) {
        console.log('📧 No new registrations to send in this batch.');
        return;
    }
    console.log(`📧 Preparing to send batch email for ${fileQueue.length} student(s) to faculty...`);
    
    try {
        // Generate a temporary Excel report from MongoDB data
        const allRegistrations = await Registration.find({}).lean();
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Registrations');

        // --- UPDATED AND EXPANDED COLUMNS ---
        worksheet.columns = [
            { header: 'Serial No', key: 'serialNumber', width: 15 },
            { header: 'Submission Date', key: 'submissionDate', width: 25 },
            { header: 'Applicant Name', key: 'applicantName', width: 30 },
            { header: 'Course Name', key: 'courseName', width: 40 },
            { header: 'Department', key: 'department', width: 20 },
            { header: 'Duration', key: 'duration', width: 15 },
            { header: 'From Date', key: 'fromDate', width: 15 },
            { header: 'To Date', key: 'toDate', width: 15 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Mobile', key: 'mobile', width: 20 },
            { header: 'Gender', key: 'gender', width: 10 },
            { header: 'Date of Birth', key: 'dob', width: 15 },
            { header: 'Father Name', key: 'fatherName', width: 30 },
            { header: 'Mother Name', key: 'motherName', width: 30 },
            { header: 'Address', key: 'address', width: 50 },
            { header: 'Aadhar', key: 'aadhar', width: 20 },
            { header: 'Caste Category', key: 'casteCategory', width: 20 },
            { header: 'Course Fees', key: 'course_fees', width: 15 },
            { header: 'Certificate URL', key: 'certificateUrl', width: 50 },
            { header: 'Application URL', key: 'applicationFormUrl', width: 50 },
        ];
        
        worksheet.addRows(allRegistrations);
        const tempExcelPath = path.join(outputDir, `report-${Date.now()}.xlsx`);
        await workbook.xlsx.writeFile(tempExcelPath);

        const excelContent = await fs.readFile(tempExcelPath);
        const attachments = [{
            content: excelContent.toString('base64'),
            filename: 'Master_Registration_Report.xlsx',
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            disposition: 'attachment',
        }];

        let studentLinksHtml = '<ul>';
        fileQueue.forEach(student => {
            studentLinksHtml += `
                <li>
                    <strong>${student.studentName}</strong><br>
                    <a href="${student.applicationFormUrl}">View Application</a> | 
                    <a href="${student.certificateUrl}">View Certificate</a>
                </li>
            `;
        });
        studentLinksHtml += '</ul>';
        
        const mailOptions = {
            from: {
                name: "CITD Registration System",
                email: process.env.SENDER_EMAIL
            },
            to: process.env.FACULTY_EMAIL,
            subject: `Student Registration Batch Report - ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
            html: `<h3>Batch Registration Report</h3>
                   <p>Please find links for <strong>${fileQueue.length}</strong> new student(s) who registered in this period:</p>
                   ${studentLinksHtml}
                   <p>The updated master registration report from the database is also attached.</p>`,
            attachments: attachments,
        };

        await sgMail.send(mailOptions);
        console.log('✅ Batch email sent successfully to faculty.');

        // Clean up temporary Excel file
        await fs.unlink(tempExcelPath);
        fileQueue = [];
    } catch (error) {
        console.error('❌ CRITICAL ERROR: Failed to send batch email to faculty.', error);
        if (error.response) { console.error(error.response.body); }
    }
}
// Redirect root to the application form
app.get('/', (req, res) => {
    res.redirect('/application_form/index.html');
});

cron.schedule('15 0 * * *', sendBatchedFacultyEmail, { timezone: "Asia/Kolkata" });
cron.schedule('20 0 * * *', sendBatchedFacultyEmail, { timezone: "Asia/Kolkata" });
console.log('🕒 Email scheduler is running. Batches will be sent at 12:15 AM and 12:20 AM.');

// --- API ENDPOINT ---
app.post('/api/submit-form', async (req, res) => {
    console.log('\n-----------------------------------------');
    console.log(`➡️ Received new form submission at ${new Date().toLocaleTimeString()}`);
    try {
        const serialNumber = await getNextSerialNumber();
        const fullFormData = { ...req.body, serialNumber };

        const certificate = await generateCertificate(fullFormData);
        const applicationForm = await generateApplicationFormPdf(fullFormData);
        
        const dbData = { 
            ...fullFormData,
            certificateUrl: certificate.url,
            applicationFormUrl: applicationForm.url
        };
        
        const newRegistration = new Registration(dbData);
        await newRegistration.save();
        
        await sendStudentEmail(fullFormData, applicationForm.path);
        
        fileQueue.push({ 
        studentName: fullFormData.applicantName,
        certificateUrl: certificate.url,
        applicationFormUrl: applicationForm.url
        });
        
        console.log(`📥 Files for ${fullFormData.applicantName} added to the faculty email queue.`);

        await fs.unlink(certificate.path);
        await fs.unlink(applicationForm.path);
        res.status(200).json({ message: 'Registration successful!' });

    } catch (error) {
        console.error('❌ An error occurred during processing:', error);
        res.status(500).json({ message: 'An error occurred on the server.', error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    // No need to log the full path anymore since we have the root redirect
});