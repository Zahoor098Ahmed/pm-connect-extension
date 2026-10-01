-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jun 08, 2026 at 08:17 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `projex_db`
--

-- --------------------------------------------------------

--
-- Table structure for table `admins`
--

CREATE TABLE `admins` (
  `id` int(10) UNSIGNED NOT NULL,
  `email` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `admins`
--

INSERT INTO `admins` (`id`, `email`, `password`, `created_at`) VALUES
(1, 'admin@example.com', '$2y$10$eoqTB9IOjEVzz3Yj4uf3oeDy/H19ncON61VWM3Ez26HKvrwBsVo.y', '2026-06-06 05:55:43');

-- --------------------------------------------------------

--
-- Table structure for table `projects`
--

CREATE TABLE `projects` (
  `id` int(10) UNSIGNED NOT NULL,
  `name` varchar(255) NOT NULL,
  `type` varchar(100) NOT NULL,
  `status` enum('active','on-hold','draft') NOT NULL DEFAULT 'active',
  `description` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `payment_type` enum('paid','unpaid') NOT NULL DEFAULT 'paid',
  `project_origin` enum('client','internal') NOT NULL DEFAULT 'client',
  `country` varchar(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `projects`
--

INSERT INTO `projects` (`id`, `name`, `type`, `status`, `description`, `created_at`, `updated_at`, `payment_type`, `project_origin`, `country`) VALUES
(1, 'project managemenet', 'Design', 'active', 'hello', '2026-06-05 05:30:10', '2026-06-05 05:30:10', 'paid', 'client', NULL),
(2, 'time global', 'design', 'draft', 'hello', '2026-06-05 11:02:31', '2026-06-05 11:02:31', 'paid', 'client', NULL),
(3, 'er', 'mobile development', 'on-hold', 'wsarg', '2026-06-05 12:02:13', '2026-06-05 12:02:13', 'paid', 'client', NULL),
(4, 'gsygh', 'mobile development', 'on-hold', 'wrtrg', '2026-06-06 07:10:26', '2026-06-06 07:10:26', 'paid', 'client', 'Saudi Arabia'),
(5, 'grf', 'web development', 'draft', 'tefhg', '2026-06-06 07:51:53', '2026-06-06 07:51:53', 'paid', 'client', 'Canada'),
(6, 'sample testing', 'mobile development', 'draft', 'desc', '2026-06-06 10:41:55', '2026-06-06 10:41:55', 'paid', 'client', '');

-- --------------------------------------------------------

--
-- Table structure for table `project_files`
--

CREATE TABLE `project_files` (
  `id` int(10) UNSIGNED NOT NULL,
  `project_id` int(10) UNSIGNED NOT NULL,
  `original_name` varchar(255) NOT NULL,
  `stored_name` varchar(255) NOT NULL,
  `file_size` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `uploaded_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project_files`
--

INSERT INTO `project_files` (`id`, `project_id`, `original_name`, `stored_name`, `file_size`, `uploaded_at`) VALUES
(1, 1, 'PIP_Billing_Module_Addendum.md', 'file_6a225ee22fa478.55764698.md', 13727, '2026-06-05 05:30:10'),
(2, 2, '.python_history', 'file_6a22acc7d9d377.50799762.python_history', 35, '2026-06-05 11:02:31'),
(3, 3, '.python_history', 'file_6a22bac55ee990.21632003.python_history', 35, '2026-06-05 12:02:13'),
(4, 4, 'Screenshot 2026-05-13 161538.png', 'file_6a23c7e2332fe7.17300636.png', 502413, '2026-06-06 07:10:26'),
(5, 5, 'Screenshot 2026-05-14 100044.png', 'file_6a23d1990331f7.41139716.png', 63929, '2026-06-06 07:51:53'),
(6, 6, 'SALES AI CRM png.png', 'file_6a2405782f84f0.57570827.png', 96395, '2026-06-06 11:33:12');

-- --------------------------------------------------------

--
-- Table structure for table `project_links`
--

CREATE TABLE `project_links` (
  `id` int(11) NOT NULL,
  `project_id` int(11) NOT NULL,
  `title` varchar(255) NOT NULL,
  `url` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project_links`
--

INSERT INTO `project_links` (`id`, `project_id`, `title`, `url`, `created_at`) VALUES
(1, 6, 'project', 'http://localhost/time%20Global%20project/#', '2026-06-06 11:27:50'),
(2, 6, 'sales CRM', 'http://localhost:5173/', '2026-06-06 11:38:51'),
(3, 6, 'time global', 'https://timeglobaltech.com/', '2026-06-06 11:48:50');

-- --------------------------------------------------------

--
-- Table structure for table `project_types`
--

CREATE TABLE `project_types` (
  `id` int(10) UNSIGNED NOT NULL,
  `name` varchar(100) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tasks`
--

CREATE TABLE `tasks` (
  `id` int(11) NOT NULL,
  `project_id` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `assignee` varchar(255) DEFAULT NULL,
  `status` enum('pending','completed') DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `tasks`
--

INSERT INTO `tasks` (`id`, `project_id`, `title`, `description`, `assignee`, `status`, `created_at`) VALUES
(1, 1, 'test task', '', '', 'pending', '2026-06-06 11:36:18'),
(2, 6, 'money mind', '', '', 'pending', '2026-06-06 11:36:49'),
(3, 6, 'testing', '', '', 'completed', '2026-06-06 11:46:09');

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(10) UNSIGNED NOT NULL,
  `name` varchar(100) NOT NULL,
  `email` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `name`, `email`, `password`, `created_at`) VALUES
(1, 'ali', 'ali@gmail.com', '$2y$10$RJclM7MIV40wxYsBaKyG/eLI.SWcr77dxQN.wj/BJNHngrRdvGmEy', '2026-06-08 05:49:22');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admins`
--
ALTER TABLE `admins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `projects`
--
ALTER TABLE `projects`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_created` (`created_at`);

--
-- Indexes for table `project_files`
--
ALTER TABLE `project_files`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_files_project` (`project_id`);

--
-- Indexes for table `project_links`
--
ALTER TABLE `project_links`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `project_types`
--
ALTER TABLE `project_types`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_type_name` (`name`);

--
-- Indexes for table `tasks`
--
ALTER TABLE `tasks`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_project` (`project_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admins`
--
ALTER TABLE `admins`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `projects`
--
ALTER TABLE `projects`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- AUTO_INCREMENT for table `project_files`
--
ALTER TABLE `project_files`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- AUTO_INCREMENT for table `project_links`
--
ALTER TABLE `project_links`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `project_types`
--
ALTER TABLE `project_types`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `tasks`
--
ALTER TABLE `tasks`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `project_files`
--
ALTER TABLE `project_files`
  ADD CONSTRAINT `fk_files_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
