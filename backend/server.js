// server.js - DEPLOYMENT VERSION (with MongoDB & Cloudinary)

// 1. Import necessary packages
const express = require('express');
const puppeteer = require('puppeteer');
const mongoose = require('mongoose'); // For MongoDB
const cloudinary = require('cloudinary').v2; // For Cloudinary
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const ExcelJS = require('exceljs'); // Still needed for faculty report
require('dotenv').config();

// 2. Initialize Express & Cloudinary
const app = express();
const PORT = process.env.PORT || 5000; // Use Render's port or 5000 locally

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

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
    certificateUrl: String, // To store the permanent PDF link
    applicationFormUrl: String, // To store the permanent PDF link
    submissionDate: { type: Date, default: Date.now }
});

const Registration = mongoose.model('Registration', registrationSchema);

// 3. Middleware Setup
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Define paths
const outputDir = path.join(__dirname, '..', 'output'); // Now a temporary folder
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
    let currentNumber;
    try {
        const data = await fs.readFile(serialNumberFilePath, 'utf8');
        currentNumber = parseInt(data, 10);
    } catch (error) { currentNumber = 818; }
    const nextNumber = currentNumber + 1;
    await fs.writeFile(serialNumberFilePath, nextNumber.toString(), 'utf8');
    return nextNumber.toString().padStart(6, '0');
}

// NEW: Function to upload files to Cloudinary for permanent storage
async function uploadToCloudinary(filePath, studentName) {
    try {
        const result = await cloudinary.uploader.upload(filePath, {
            resource_type: 'raw', // Important for non-image files like PDFs
            public_id: `citd-forms/${studentName}_${path.basename(filePath)}`,
        });
        await fs.unlink(filePath); // Delete temporary local file after upload
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
    await page.setContent(finalHtml, { waitUntil: 'networkidle0' });

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
    await page.setContent(finalHtml, { waitUntil: 'networkidle0' });

    await page.evaluate(data => {
        // This function should contain all the logic to fill your form fields
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


// --- EMAIL FUNCTIONS ---
async function sendStudentEmail(data, applicationFormPath) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    const mailOptions = {
        from: `"CITD Hyderabad" <${process.env.EMAIL_USER}>`,
        to: data.email,
        subject: 'Application Received - CITD Short Term Course',
        html: `<h3>Dear ${data.applicantName},</h3><p>Thank you for registering...</p>`,
        attachments: [{
            filename: path.basename(applicationFormPath),
            path: applicationFormPath,
        }],
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Confirmation email sent to student: ${data.email}`);
    } catch (error) {
        console.error(`❌ Failed to send email to student: ${data.email}`, error);
    }
}

async function sendBatchedFacultyEmail() {
    if (fileQueue.length === 0) {
        console.log('📧 No new registrations to send in this batch.');
        return;
    }
    console.log(`📧 Preparing to send batch email with ${fileQueue.length / 2} student(s) to faculty...`);
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    
    // Create attachments from local file paths
    const attachments = fileQueue.map(item => ({
        filename: path.basename(item.path),
        path: item.path,
    }));
    
    // Generate a temporary Excel report from MongoDB data
    const allRegistrations = await Registration.find({}).lean();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Registrations');
    worksheet.columns = [
        { header: 'Serial No', key: 'serialNumber', width: 15 },
        { header: 'Applicant Name', key: 'applicantName', width: 30 },
        { header: 'Course Name', key: 'courseName', width: 30 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Certificate URL', key: 'certificateUrl', width: 50 },
        { header: 'Application URL', key: 'applicationFormUrl', width: 50 },
    ];
    worksheet.addRows(allRegistrations);
    const tempExcelPath = path.join(outputDir, `report-${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(tempExcelPath);

    attachments.push({
        filename: 'Master_Registration_Report.xlsx',
        path: tempExcelPath,
    });

    const mailOptions = {
        from: `"CITD Registration System" <${process.env.EMAIL_USER}>`,
        to: process.env.FACULTY_EMAIL,
        subject: `Student Registration Batch Report - ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        html: `<h3>Batch Registration Report</h3><p>Please find attached documents for <strong>${fileQueue.length / 2}</strong> new student(s) who registered in this period.</p><p>The updated master registration report from the database is also attached.</p>`,
        attachments: attachments,
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log('✅ Batch email sent successfully to faculty.');
        // Clean up temporary files
        fileQueue.forEach(file => fs.unlink(file.path).catch(err => console.error(`Error deleting temp file: ${file.path}`, err)));
        await fs.unlink(tempExcelPath);
        fileQueue = [];
    } catch (error) {
        console.error('❌ CRITICAL ERROR: Failed to send batch email to faculty.', error);
    }
}


// --- SCHEDULER ---
cron.schedule('46 0 * * *', sendBatchedFacultyEmail, { timezone: "Asia/Kolkata" });
cron.schedule('0 13 * * *', sendBatchedFacultyEmail, { timezone: "Asia/Kolkata" });
console.log('🕒 Email scheduler is running. Batches will be sent at 12:46 AM and 1:00 PM.');

// --- API ENDPOINT ---
app.post('/api/submit-form', async (req, res) => {
    console.log('\n-----------------------------------------');
    console.log(`➡️ Received new form submission at ${new Date().toLocaleTimeString()}`);
    try {
        const serialNumber = await getNextSerialNumber();
        const fullFormData = { ...req.body, serialNumber };

        const certificate = await generateCertificate(fullFormData);
        const applicationForm = await generateApplicationFormPdf(fullFormData);
        
        // Save URLs and data to MongoDB
        const dbData = { 
            ...fullFormData,
            certificateUrl: certificate.url,
            applicationFormUrl: applicationForm.url
        };
        
        const newRegistration = new Registration(dbData);
        await newRegistration.save();
        
        await sendStudentEmail(fullFormData, applicationForm.path);
        
        fileQueue.push({ type: 'certificate', path: certificate.path });
        fileQueue.push({ type: 'application', path: applicationForm.path });
        
        console.log(`📥 Files for ${fullFormData.applicantName} added to the faculty email queue.`);
        res.status(200).json({ message: 'Registration successful!' });

    } catch (error) {
        console.error('❌ An error occurred during processing:', error);
        res.status(500).json({ message: 'An error occurred on the server.', error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`➡️ Access your form at: http://localhost:${PORT}/application_form/index.html`);
});
